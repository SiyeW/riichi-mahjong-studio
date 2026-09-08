"""Own opponent-prediction request queues and their worker lifecycle."""

from __future__ import annotations

import copy
import threading
import traceback
from collections import deque
from collections.abc import Callable
from typing import Any

from opponent_prediction_activity import OpponentPredictionActivity

PredictionResult = dict[str, Any]
PredictionRequest = dict[str, Any]


class OpponentPredictionRequests:
    def __init__(
        self,
        *,
        activity: OpponentPredictionActivity,
        supported_input_modes: Callable[[], tuple[str, ...]],
        is_initializing: Callable[[], bool],
        prewarm: Callable[[], bool],
        execute: Callable[[PredictionRequest, bool], tuple[PredictionResult, float]],
        activity_error: Callable[[], str | None],
        format_error: Callable[[str, Exception], str],
    ) -> None:
        self._activity = activity
        self._supported_input_modes = supported_input_modes
        self._is_initializing = is_initializing
        self._prewarm = prewarm
        self._execute = execute
        self._activity_error = activity_error
        self._format_error = format_error
        self._lock = threading.Lock()
        self._latest: PredictionResult = {
            "opponents": {},
            "status": "loading",
        }
        self._running = True
        self._pending: PredictionRequest | None = None
        self._background_pending: deque[PredictionRequest] = deque()
        self._latest_context: dict[str, Any] | None = None
        self._pending_event = threading.Event()
        self._active_context: dict[str, Any] | None = None
        self._active_background = False
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def request_foreground(
        self,
        snapshot: dict[str, Any],
        controlled_seat: int,
        *,
        input_mode: str,
        context: dict[str, Any] | None,
        on_complete: Callable[[PredictionResult], None] | None,
        mjai_events: list[dict] | None,
        mjai_prefix_hashes: list[int] | None,
        mjai_events_hash: int | None,
        target_mjai_events: list[dict] | None,
        target_mjai_prefix_hashes: list[int] | None,
        target_mjai_events_hash: int | None,
        include_ground_truth: bool,
    ) -> None:
        if not self._activity.accepts_requests():
            return
        self._validate_input_mode(input_mode)
        request_context = copy.deepcopy(context or {})
        request = self._make_request(
            snapshot,
            controlled_seat,
            input_mode=input_mode,
            context=request_context,
            on_complete=on_complete,
            mjai_events=mjai_events,
            mjai_prefix_hashes=mjai_prefix_hashes,
            mjai_events_hash=mjai_events_hash,
            target_mjai_events=target_mjai_events,
            target_mjai_prefix_hashes=target_mjai_prefix_hashes,
            target_mjai_events_hash=target_mjai_events_hash,
            include_ground_truth=include_ground_truth,
            background=False,
        )
        with self._lock:
            self._latest_context = request_context
            self._pending = request
            self._latest = {
                "predictions": {"opponents": {}, "ron_wait": {}},
                "ground_truth": {"opponents": {}, "ron_wait": {}},
                "context": copy.deepcopy(request_context),
                "status": "loading",
            }
        initializing = self._is_initializing()
        self._activity.set("loading" if initializing else "running")
        self._pending_event.set()

    def request_background(
        self,
        snapshot: dict[str, Any],
        controlled_seat: int,
        *,
        input_mode: str,
        context: dict[str, Any] | None,
        on_complete: Callable[[PredictionResult], None] | None,
        mjai_events: list[dict] | None,
        mjai_prefix_hashes: list[int] | None,
        mjai_events_hash: int | None,
        target_mjai_events: list[dict] | None,
        target_mjai_prefix_hashes: list[int] | None,
        target_mjai_events_hash: int | None,
        include_ground_truth: bool,
    ) -> bool:
        if not self._activity.accepts_requests():
            return False
        self._validate_input_mode(input_mode)
        request_context = copy.deepcopy(context or {})
        request = self._make_request(
            snapshot,
            controlled_seat,
            input_mode=input_mode,
            context=request_context,
            on_complete=on_complete,
            mjai_events=mjai_events,
            mjai_prefix_hashes=mjai_prefix_hashes,
            mjai_events_hash=mjai_events_hash,
            target_mjai_events=target_mjai_events,
            target_mjai_prefix_hashes=target_mjai_prefix_hashes,
            target_mjai_events_hash=target_mjai_events_hash,
            include_ground_truth=include_ground_truth,
            background=True,
        )
        with self._lock:
            duplicate = (
                self._active_background
                and self._active_context == request_context
            ) or any(
                item.get("context") == request_context
                for item in self._background_pending
            )
            if duplicate:
                return False
            self._background_pending.append(request)
        self._pending_event.set()
        return True

    @staticmethod
    def _make_request(
        snapshot: dict[str, Any],
        controlled_seat: int,
        *,
        input_mode: str,
        context: dict[str, Any],
        on_complete: Callable[[PredictionResult], None] | None,
        mjai_events: list[dict] | None,
        mjai_prefix_hashes: list[int] | None,
        mjai_events_hash: int | None,
        target_mjai_events: list[dict] | None,
        target_mjai_prefix_hashes: list[int] | None,
        target_mjai_events_hash: int | None,
        include_ground_truth: bool,
        background: bool,
    ) -> PredictionRequest:
        has_prebuilt_streams = mjai_events is not None and (
            target_mjai_events is not None or not include_ground_truth
        )
        return {
            "snapshot": None if has_prebuilt_streams else copy.deepcopy(snapshot),
            "controlled_seat": int(controlled_seat),
            "input_mode": input_mode,
            "context": context,
            "on_complete": on_complete,
            "background": background,
            "mjai_events": mjai_events,
            "mjai_prefix_hashes": mjai_prefix_hashes,
            "mjai_events_hash": mjai_events_hash,
            "target_mjai_events": target_mjai_events,
            "target_mjai_prefix_hashes": target_mjai_prefix_hashes,
            "target_mjai_events_hash": target_mjai_events_hash,
            "include_ground_truth": bool(include_ground_truth),
        }

    def _validate_input_mode(self, input_mode: str) -> None:
        if input_mode not in self._supported_input_modes():
            raise ValueError(
                f"Unsupported opponent-analysis input mode: {input_mode}"
            )

    def get_latest(self) -> PredictionResult:
        with self._lock:
            return copy.deepcopy(self._latest)

    def mark_loaded(self) -> None:
        with self._lock:
            self._latest["status"] = "loaded"

    def mark_loading(self) -> None:
        with self._lock:
            self._latest["status"] = "loading"

    def has_work(self) -> bool:
        with self._lock:
            return self._pending is not None or self._active_context is not None

    def has_request(self, context: dict[str, Any]) -> bool:
        with self._lock:
            pending_context = self._pending.get("context") if self._pending else None
            active_context = None if self._active_background else self._active_context
            return pending_context == context or active_context == context

    def set_latest_context(self, context: dict[str, Any] | None) -> None:
        with self._lock:
            self._latest_context = (
                copy.deepcopy(context) if context is not None else None
            )
            if (
                self._pending is not None
                and self._pending.get("context") != self._latest_context
            ):
                self._pending = None
                if self._background_pending:
                    self._pending_event.set()
                else:
                    self._pending_event.clear()

    def cancel_pending(self) -> None:
        with self._lock:
            self._latest_context = None
            self._pending = None
            has_queued_work = bool(self._background_pending)
            has_active_request = self._active_context is not None
            if not has_queued_work:
                self._pending_event.clear()
        if not has_active_request and self._activity.state() != "error":
            self._activity.set("idle")

    def cancel_background(self) -> None:
        with self._lock:
            self._background_pending.clear()
            has_foreground_work = self._pending is not None
            has_active_request = self._active_context is not None
            if not has_foreground_work:
                self._pending_event.clear()
        if (
            not has_active_request
            and not has_foreground_work
            and self._activity.state() != "error"
        ):
            self._activity.set("idle")

    def cancel_all(self) -> None:
        with self._lock:
            self._latest_context = None
            self._pending = None
            self._background_pending.clear()
            self._pending_event.clear()
            has_active_request = self._active_context is not None
        if not has_active_request and self._activity.state() != "error":
            self._activity.set("idle")

    def _is_superseded(self, context: dict[str, Any]) -> bool:
        with self._lock:
            return self._latest_context != context

    def _run(self) -> None:
        while self._running:
            self._pending_event.wait()
            if not self._running:
                break
            pending = self._take_next()
            if pending is None:
                continue
            initializing = self._is_initializing()
            self._activity.set("loading" if initializing else "running")
            try:
                if initializing and not self._prewarm():
                    raise RuntimeError(
                        self._activity_error()
                        or "对手分析引擎初始化失败"
                    )
                context = pending.get("context") or {}
                is_background = bool(pending.get("background"))
                if not is_background and self._is_superseded(context):
                    continue
                result, elapsed_ms = self._execute(pending, initializing)
                if not is_background and self._is_superseded(context):
                    continue
                if not is_background and not self._publish_if_current(
                    context,
                    result,
                ):
                    continue
                self._activity.record_response_ms(elapsed_ms)
                self._notify_completion(pending, result)
            except Exception as exc:
                self._handle_failure(pending, exc)
            finally:
                self._finish_request()

    def _take_next(self) -> PredictionRequest | None:
        with self._lock:
            pending = self._pending
            if pending is not None:
                self._pending = None
            elif self._background_pending:
                pending = self._background_pending.popleft()
            if pending is not None:
                self._active_context = copy.deepcopy(
                    pending.get("context") or {}
                )
                self._active_background = bool(pending.get("background"))
            self._pending_event.clear()
            return pending

    def _publish_if_current(
        self,
        context: dict[str, Any],
        result: PredictionResult,
    ) -> bool:
        with self._lock:
            if self._latest_context != context:
                return False
            self._latest = result
            return True

    def _handle_failure(
        self,
        pending: PredictionRequest,
        error: Exception,
    ) -> None:
        context = pending.get("context") or {}
        if not pending.get("background") and self._is_superseded(context):
            return
        print(f"[SHANTEN] Prediction error: {error}", flush=True)
        traceback.print_exc()
        self._activity.set(
            "error",
            self._format_error("模型推理失败", error),
            latch_error=False,
        )
        error_result = {
            "predictions": {"opponents": {}, "ron_wait": {}},
            "ground_truth": {"opponents": {}, "ron_wait": {}},
            "context": copy.deepcopy(context),
            "status": f"prediction_error: {error}",
        }
        if not pending.get("background") and not self._publish_if_current(
            context,
            error_result,
        ):
            return
        self._notify_completion(pending, error_result)

    @staticmethod
    def _notify_completion(
        pending: PredictionRequest,
        result: PredictionResult,
    ) -> None:
        callback = pending.get("on_complete")
        if not callable(callback):
            return
        try:
            callback(copy.deepcopy(result))
        except Exception as callback_error:  # pylint: disable=broad-except
            print(
                f"[SHANTEN] Cache callback failed: {callback_error}",
                flush=True,
            )

    def _finish_request(self) -> None:
        with self._lock:
            self._active_context = None
            self._active_background = False
            has_pending = self._pending is not None or bool(
                self._background_pending
            )
            if has_pending:
                self._pending_event.set()
        if not has_pending and self._activity.state() != "error":
            self._activity.set("idle")

    def shutdown(self) -> None:
        self._running = False
        self._pending_event.set()
