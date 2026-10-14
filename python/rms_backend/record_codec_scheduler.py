"""One bounded, fair CPU lane; foreground table commands never wait here."""

from collections import OrderedDict
from concurrent.futures import Future
from threading import Condition, Thread

from .record_codec_client import RecordCodecClient


class CodecCapacityError(RuntimeError):
    pass


class ResultReservation:
    """Capacity reserved before inference, retained until backing owns the result."""

    def __init__(self, scheduler, foreground):
        self.scheduler, self.foreground = scheduler, foreground
        self.released = self.submitted = False

    def release(self):
        self.scheduler.release(self)


class RecordCodecScheduler:
    def __init__(self, *, client=None, background_slots=2, foreground_slots=1,
                 demanded_limit=4, prefetch_limit=3, fairness=4):
        self.client = client or RecordCodecClient()
        self._condition = Condition()
        self._limits = (background_slots, foreground_slots)
        self._counts = [0, 0]
        self._read_limits = (demanded_limit, prefetch_limit)
        self._fairness, self._demand_streak = fairness, 0
        self._required = OrderedDict()
        self._demanded, self._prefetch = OrderedDict(), OrderedDict()
        self._active = None
        self._thread = None
        self._closed = False
        self._bound = None

    def reserve(self, *, foreground=False, block=False):
        """Nonblocking under gameplay lock; only explicit off-lock saves wait."""
        lane = int(foreground)
        with self._condition:
            while not self._closed and self._counts[lane] >= self._limits[lane]:
                if not block:
                    return None
                self._condition.wait()
            if self._closed:
                raise RuntimeError('Record codec scheduler is closed.')
            self._counts[lane] += 1
            return ResultReservation(self, foreground)

    def release(self, reservation):
        with self._condition:
            if reservation.scheduler is not self:
                raise ValueError('Result reservation belongs to another scheduler.')
            if not reservation.released:
                self._counts[int(reservation.foreground)] -= 1
                reservation.released = True
                self._condition.notify_all()

    def _start(self):
        if self._thread is None:
            self._thread = Thread(target=self._run, name='record-codec-scheduler', daemon=True)
            self._thread.start()
        self._condition.notify_all()

    def submit_required(self, reservation, work, *, retry=False):
        with self._condition:
            if (self._closed or reservation.scheduler is not self or reservation.released
                    or reservation.submitted and not retry
                    or reservation in self._required
                    or self._active and self._active[0] is reservation):
                raise ValueError('A live unused result reservation is required.')
            reservation.submitted = True
            future = Future()
            self._required[reservation] = (future, work, None)
            self._start()
            return future

    def submit_read(self, key, work, *, prefetch=False, group=None):
        cancelled = []
        with self._condition:
            if self._closed:
                raise RuntimeError('Record codec scheduler is closed.')
            if self._active and self._active[0] == key:
                return self._active[1]
            if key in self._demanded:
                return self._demanded[key][0]
            if key in self._prefetch:
                job = self._prefetch.pop(key)
                if prefetch:
                    self._prefetch[key] = job
                    return job[0]
            else:
                job = (Future(), work, group)
            queue = self._prefetch if prefetch else self._demanded
            if not prefetch and group is not None:
                for old_key, old in tuple(queue.items()):
                    if old[2] == group:
                        cancelled.append(queue.pop(old_key)[0])
            if len(queue) >= self._read_limits[int(prefetch)]:
                cancelled.append(queue.popitem(last=False)[1][0])
            queue[key] = job
            self._start()
        # Future callbacks may take owner locks; never invoke them under this lock.
        for future in cancelled:
            future.cancel()
        return job[0]

    def cancel_prefetch(self):
        with self._condition:
            cancelled = [job[0] for job in self._prefetch.values()]
            self._prefetch.clear()
        for future in cancelled:
            future.cancel()

    def promote_read(self, key, *, group=None):
        cancelled = []
        with self._condition:
            job = self._prefetch.pop(key, None)
            if job is None:
                return self._demanded.get(key, (None,))[0]
            future, work, old_group = job
            if group is not None:
                for old_key, old in tuple(self._demanded.items()):
                    if old[2] == group:
                        cancelled.append(self._demanded.pop(old_key)[0])
            if len(self._demanded) >= self._read_limits[0]:
                cancelled.append(self._demanded.popitem(last=False)[1][0])
            self._demanded[key] = (future, work, group if group is not None else old_group)
            self._start()
        for previous in cancelled:
            previous.cancel()
        return future

    def codec(self, namespace, schemas, operation, **payload):
        """Called only by a scheduled work item, not by a foreground consumer."""
        identity = (self.client.generation, namespace)
        if self.client.pid is None or self._bound != identity:
            self.client.call('bind', namespace=namespace, schemas=schemas)
            self._bound = (self.client.generation, namespace)
        return self.client.call(operation, namespace=namespace, **payload)

    def _take(self):
        if self._required and (not self._demanded or self._demand_streak >= self._fairness):
            self._demand_streak = 0
            key, job = self._required.popitem(last=False)
            return key, job
        if self._demanded:
            self._demand_streak += 1
            return self._demanded.popitem(last=False)
        if self._prefetch:
            return self._prefetch.popitem(last=False)
        return None

    def _run(self):
        while True:
            with self._condition:
                while not self._closed and not (self._required or self._demanded or self._prefetch):
                    self._condition.wait()
                if self._closed:
                    return
                key, (future, work, _group) = self._take()
                self._active = (key, future)
            try:
                if future.set_running_or_notify_cancel():
                    try:
                        result = work(self)
                    except Exception as error:
                        future.set_exception(error)
                    else:
                        future.set_result(result)
            finally:
                # Do not leave completed closures/results retained by an idle lane.
                work = result = future = None
                with self._condition:
                    self._active = None

    def metrics(self):
        with self._condition:
            return {'backgroundReserved': self._counts[0], 'foregroundReserved': self._counts[1],
                    'requiredQueued': len(self._required), 'demandedQueued': len(self._demanded),
                    'prefetchQueued': len(self._prefetch), 'active': self._active is not None}

    def close(self):
        with self._condition:
            if self._closed:
                return
            self._closed = True
            pending = [job[0] for queue in (self._required, self._demanded, self._prefetch)
                       for job in queue.values()]
            self._required.clear()
            self._demanded.clear()
            self._prefetch.clear()
            self._condition.notify_all()
        for future in pending:
            if not future.cancelled():
                future.set_exception(RuntimeError('Record codec scheduler stopped before completion.'))
        self.client.close()
        if self._thread is not None:
            self._thread.join(timeout=3)
            if self._thread.is_alive():
                raise RuntimeError('Record codec scheduler did not stop.')
