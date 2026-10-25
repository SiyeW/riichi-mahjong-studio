"""Demand saved facts asynchronously; publish only to their current visit.

The codec and game loop never wait for renderer transport. This owner has one
replaceable delivery per kind, not an unbounded executor queue or decoded cache.
"""

from threading import Condition, Thread, Timer
from concurrent.futures import Future

from .records.legacy_codec import AnalysisReadError
from .records.analysis_refs import AnalysisReference


class AnalysisReadPresenter:
    def __init__(self, state_lock, view_token, emit):
        self.state_lock, self.view_token, self.emit = state_lock, view_token, emit
        self._subscriptions, self._observed = {}, {}
        self._condition = Condition()
        self._deliveries = {}
        self._thread = None
        self._closed = False
        self._retry_timers = {}

    @staticmethod
    def _payload(kind, value, context, terminal, metadata):
        value = {**value, **metadata} if metadata else value
        if kind == 'opponent':
            return {**value, 'context': {**context, 'dataState': 'ready'}, **({'status': 'terminal'} if terminal else {})}
        return value

    def read(self, reference, *, kind, context=None, terminal=False, metadata=None):
        """Called under game lock. No filesystem/codec wait or inference here."""
        if not isinstance(reference, AnalysisReference):
            raise TypeError('Async reads require record-owned analysis references.')
        token = self.view_token()
        self._subscriptions[kind] = (reference, token, context, terminal, metadata)
        hot = reference.ready_value()
        if hot is not None:
            self._cancel_retry(kind)
            return self._payload(kind, hot, context, terminal, metadata)
        try:
            future = reference.request(group=('visible-analysis', kind))
        except AnalysisReadError as error:
            self._cancel_retry(kind)
            return self._error(kind, error, context, metadata)
        if future is None:
            hot = reference.ready_value()
            if hot is not None:
                self._cancel_retry(kind)
                return self._payload(kind, hot, context, terminal, metadata)
            self._retry_read(kind)
        else:
            self._cancel_retry(kind)
        if future is not None and self._observed.get(kind) != (reference.identity, future):
            self._observed[kind] = (reference.identity, future)
            future.add_done_callback(lambda done: self._enqueue(kind, reference.identity, done))
        return None

    def _cancel_retry(self, kind):
        with self._condition:
            timer = self._retry_timers.pop(kind, None)
        if timer is not None:
            timer.cancel()

    def _retry_read(self, kind):
        with self._condition:
            if self._closed or kind in self._retry_timers:
                return
            def retry():
                with self.state_lock:
                    with self._condition:
                        if self._retry_timers.get(kind) is not timer:
                            return
                        self._retry_timers.pop(kind)
                    subscribed = self._subscriptions.get(kind)
                    if subscribed is not None:
                        reference, token, context, terminal, metadata = subscribed
                        if token == self.view_token():
                            self.publish(reference, kind=kind, context=context, terminal=terminal, metadata=metadata)
            timer = Timer(.25, retry)
            timer.daemon = True
            self._retry_timers[kind] = timer
            timer.start()

    @staticmethod
    def _error(kind, error, context, metadata=None):
        if kind == 'opponent':
            return dict(status=f'prediction_error: {error}', error=str(error),
                        predictions={}, ground_truth={}, context={**context, 'dataState': 'failed'}, **(metadata or {}))
        return dict(error=str(error), discardEntries=[], reactionEntries=[], **(metadata or {}))

    def publish(self, reference, *, kind, context=None, terminal=False, metadata=None):
        """Model completion also publishes if encoding won the subscription race."""
        ready = self.read(reference, kind=kind, context=context, terminal=terminal, metadata=metadata)
        if ready is not None:
            future = Future()
            future.set_result(ready)
            self._observed[kind] = (reference.identity, future)
            self._enqueue(kind, reference.identity, future)

    def _enqueue(self, kind, identity, future):
        if future.cancelled():
            return
        with self.state_lock:
            if self._observed.get(kind) != (identity, future):
                return
            with self._condition:
                if self._closed:
                    return
                self._deliveries[kind] = (identity, future)
                if self._thread is None:
                    self._thread = Thread(target=self._run, name='analysis-presentation', daemon=True)
                    self._thread.start()
                self._condition.notify()

    def _run(self):
        while True:
            with self._condition:
                while not self._closed and not self._deliveries:
                    self._condition.wait()
                if self._closed:
                    return
                kind, (identity, future) = self._deliveries.popitem()
            event = None
            with self.state_lock:
                subscribed = self._subscriptions.get(kind)
                if subscribed is not None:
                    reference, token, context, terminal, metadata = subscribed
                    if (reference.identity == identity and token is not None
                            and token == self.view_token()
                            and self._observed.get(kind) == (identity, future)):
                        error = future.exception()
                        payload = (self._error(kind, error, context, metadata) if error is not None else
                                   self._payload(kind, future.result(), context, terminal, metadata))
                        event = dict(type='opponent_analysis_ready' if kind == 'opponent' else 'analysis_ready',
                                     viewToken=token, gameId=token['gameId'], nodeId=token['nodeId'],
                                     seat=token['seat'], cacheEpoch=token['decisionEpoch'])
                        event['opponentAnalysis' if kind == 'opponent' else 'analysis'] = payload
                if self._observed.get(kind) == (identity, future):
                    self._observed.pop(kind)
            if event is not None:
                self.emit(event)
            # An idle presenter must not retain the last canonical result/future.
            subscribed = reference = payload = event = future = metadata = context = token = None

    def close(self):
        with self._condition:
            self._closed = True
            self._deliveries.clear()
            self._condition.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=3)
            if self._thread.is_alive():
                raise RuntimeError('Analysis presentation transport did not stop.')
        self.reset()

    def reset(self):
        with self.state_lock:
            self._subscriptions.clear()
            self._observed.clear()
            with self._condition:
                self._deliveries.clear()
                for timer in self._retry_timers.values():
                    timer.cancel()
                self._retry_timers.clear()
