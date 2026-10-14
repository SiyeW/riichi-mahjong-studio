"""Single-thread transactional storage ownership, separate from the codec lane."""

from collections import deque
from concurrent.futures import Future
from threading import Condition, Thread

from .workspace import RecordWorkspace
from .workspace_lease import WorkspaceLease


class RecordWorkspaceWriter:
    def __init__(self, path, workspace_id, *, create=False, queue_limit=256):
        self.path, self.workspace_id = path, workspace_id
        self._condition = Condition()
        self._urgent, self._bodies = deque(), deque()
        self._limit = queue_limit
        self._closing = False
        self._health = None
        self._authored_error = None
        self._maintenance = {}
        self.ready = Future()
        self.closed = Future()
        self._thread = Thread(target=self._run, args=(create,), name='record-workspace-writer', daemon=True)
        self._thread.start()

    def submit(self, operation, *args, body=False, **kwargs):
        with self._condition:
            if self._closing:
                raise RuntimeError('Record workspace writer is closing.')
            if len(self._urgent) + len(self._bodies) >= self._limit:
                raise RuntimeError('Record workspace write queue is full.')
            future = Future()
            # Queue admission transfers ownership. Cancelling a caller's wait
            # cannot cancel an accepted authored/result write.
            future.set_running_or_notify_cancel()
            (self._bodies if body else self._urgent).append((future, operation, args, kwargs))
            self._condition.notify()
            return future

    def _run(self, create):
        workspace = lease = None
        try:
            lease = WorkspaceLease(str(self.path) + '.lock', self.workspace_id)
            workspace = RecordWorkspace(self.path, workspace_id=self.workspace_id, create=create)
            self.ready.set_result(workspace)
        except Exception as error:
            self._health = str(error)
            self.ready.set_exception(error)
            with self._condition:
                self._closing = True
                self._condition.notify_all()
        dirty_bytes = 0
        urgent_streak = 0
        while True:
            with self._condition:
                while not self._closing and not (self._urgent or self._bodies):
                    self._condition.wait()
                if self._closing and not (self._urgent or self._bodies):
                    break
                if self._urgent and (not self._bodies or urgent_streak < 8):
                    job = self._urgent.popleft()
                    urgent_streak += 1
                else:
                    job = self._bodies.popleft()
                    urgent_streak = 0
            future, operation, args, kwargs = job
            try:
                if workspace is None:
                    self.ready.result()
                if operation == 'authored_batch' and self._authored_error is not None:
                    raise OSError('An earlier authored batch must be retried before later edits can be persisted.')
                result = getattr(workspace, 'authored_batch' if operation == 'authored_retry' else operation)(*args, **kwargs)
                if operation == 'authored_retry':
                    self._authored_error = None
                self._health = None
            except Exception as error:
                self._health = str(error)
                if operation in ('authored_batch', 'authored_retry'):
                    self._authored_error = str(error)
                future.set_exception(error)
            else:
                future.set_result(result)
                dirty_bytes += workspace.take_written_bytes()
                # Maintenance is owned and off game/renderer locks. This caps
                # admitted bytes between calls, NOT SQLite's internal I/O time.
                if dirty_bytes >= 4 * 1024 * 1024:
                    try:
                        self._maintenance = workspace.maintain()
                        dirty_bytes = 0
                    except Exception as error:
                        self._health = str(error)
            finally:
                job = args = kwargs = result = future = None
        try:
            if workspace is not None:
                workspace.close()
        except Exception as error:
            self.closed.set_exception(error)
        else:
            self.closed.set_result(None)
        finally:
            if lease is not None:
                lease.close()

    def metrics(self):
        with self._condition:
            return {'queuedWrites': len(self._urgent) + len(self._bodies),
                    'error': self._authored_error or self._health,
                    'wal': dict(self._maintenance)}

    def close(self):
        with self._condition:
            self._closing = True
            self._condition.notify_all()
        self._thread.join()
        self.closed.result()
