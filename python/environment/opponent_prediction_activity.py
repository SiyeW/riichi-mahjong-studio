"""Thread-safe activity and initialization state for opponent prediction."""

from __future__ import annotations

import threading
from collections.abc import Callable


class OpponentPredictionActivity:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._callback: Callable[[str, str | None], None] | None = None
        self._state = "idle"
        self._error: str | None = None
        self._error_latched = False
        self._unloaded = True
        self._response_times: list[float] = []
        self._last_response_ms = 0.0
        self._generation = 0

    @property
    def generation(self) -> int:
        with self._lock:
            return self._generation

    def invalidate(self) -> None:
        with self._lock:
            self._generation += 1

    def reset(self, *, unloaded: bool) -> None:
        with self._lock:
            self._response_times.clear()
            self._last_response_ms = 0.0
            self._error_latched = False
            self._unloaded = unloaded

    def set_callback(
        self,
        callback: Callable[[str, str | None], None] | None,
    ) -> None:
        with self._lock:
            self._callback = callback

    def state(self) -> str:
        with self._lock:
            return self._state

    def error(self) -> str | None:
        with self._lock:
            return self._error

    def is_unloaded(self) -> bool:
        with self._lock:
            return self._unloaded

    def accepts_requests(self) -> bool:
        with self._lock:
            return not self._error_latched and not self._unloaded

    def can_initialize(self) -> bool:
        return self.accepts_requests()

    def error_latched(self) -> bool:
        with self._lock:
            return self._error_latched

    def average_response_ms(self) -> float:
        with self._lock:
            if not self._response_times:
                return 0.0
            return sum(self._response_times) / len(self._response_times)

    def last_response_ms(self) -> float:
        with self._lock:
            return self._last_response_ms

    def record_response_ms(self, elapsed_ms: float) -> None:
        with self._lock:
            self._last_response_ms = float(elapsed_ms)
            self._response_times.append(self._last_response_ms)
            del self._response_times[:-10]

    def set(
        self,
        state: str,
        error: str | None = None,
        *,
        latch_error: bool = True,
        expected_generation: int | None = None,
    ) -> None:
        callback = None
        with self._lock:
            if (
                expected_generation is not None
                and expected_generation != self._generation
            ):
                return
            if self._unloaded:
                state = "idle"
                error = None
            if state == "error" and latch_error:
                self._error_latched = True
            elif self._error_latched:
                return
            next_error = error if state == "error" else None
            if self._state == state and self._error == next_error:
                return
            self._state = state
            self._error = next_error
            callback = self._callback
        self._notify(callback, state, next_error)

    @staticmethod
    def _notify(
        callback: Callable[[str, str | None], None] | None,
        state: str,
        error: str | None,
    ) -> None:
        if callback is None:
            return
        try:
            callback(state, error)
        except Exception:
            # The background worker must survive a closed event consumer.
            pass
