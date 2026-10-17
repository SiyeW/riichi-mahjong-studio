"""Exactly-once transfer of a prediction or its unaccepted resources."""

import threading


class PredictionCompletion:
    def __init__(self, on_complete=None, on_discard=None):
        self._lock = threading.Lock()
        self._pending = True
        self._on_complete = on_complete
        self._on_discard = on_discard

    def _claim(self):
        with self._lock:
            if not self._pending:
                return None
            self._pending = False
            callbacks = (self._on_complete, self._on_discard)
            self._on_complete = self._on_discard = None
            return callbacks

    @staticmethod
    def _discard(callback):
        if callable(callback):
            try:
                callback()
            except Exception as error:
                # One failed consumer must not strand other requests/engines.
                print(f'[SHANTEN] Discard callback failed: {error}', flush=True)

    def complete(self, result):
        callbacks = self._claim()
        if callbacks is None:
            return False
        complete, discard = callbacks
        if not callable(complete):
            self._discard(discard)
            return False
        try:
            complete(result)
        except Exception:
            self._discard(discard)
            raise
        return True

    def discard(self):
        callbacks = self._claim()
        if callbacks is None:
            return False
        self._discard(callbacks[1])
        return True
