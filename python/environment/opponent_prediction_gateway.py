"""Adapt opponent prediction outputs to the host's analysis data."""
from __future__ import annotations

import copy
import threading
import time
from collections import deque
from typing import Any, Callable, Dict, Optional

from engine_process_client import EngineProcessClient  # noqa: E402
from engine_runtime import initialize_engine_client
from engine_notification_subscription import EngineNotificationSubscription
from opponent_prediction_profile import (
    OpponentEngineIdentity,
    OpponentEngineProfile,
)
from opponent_prediction_protocol import OpponentPredictionProtocolAdapter

_LATEST_OPPONENT_PREDICTION_MJAI: Dict[str, Any] = {}


def get_latest_opponent_prediction_mjai() -> Dict[str, Any]:
    return dict(_LATEST_OPPONENT_PREDICTION_MJAI)


class OpponentPredictionGateway:
    """Run background requests for the assigned opponent prediction outputs."""

    def __init__(
        self,
        model_path: Optional[str] = None,
        enabled_outputs: Optional[list[str]] = None,
    ):
        self._profile = OpponentEngineProfile.initial(model_path, enabled_outputs)
        self._identity = OpponentEngineIdentity(self._profile)
        self._process_client = EngineProcessClient(
            "opponent-analysis",
            self._on_engine_notification,
            expected_engine_id="",
        )
        self._model_ready = False
        self._protocol_adapter = OpponentPredictionProtocolAdapter()
        self._initialization_lock = threading.Lock()
        self._lifecycle_generation = 0
        self._lock = threading.Lock()
        self._runtime_notifications = EngineNotificationSubscription(
            self._lock,
            lambda: self._process_client,
            lambda: self._lifecycle_generation,
            lambda *args, **kwargs: self._on_engine_notification(*args, **kwargs),
        )
        self._activity_lock = threading.Lock()
        self._activity_callback: Optional[Callable[[str, Optional[str]], None]] = None
        self._activity_state = "idle"
        self._activity_error: Optional[str] = None
        self._error_latched = False
        self._unloaded = True
        self._response_times: list[float] = []
        self._last_response_ms = 0.0
        self._latest: Dict[str, Any] = {"opponents": {}, "status": "loading"}
        self._running = True
        self._pending: Optional[Dict[str, Any]] = None
        self._background_pending = deque()
        self._latest_context: Optional[Dict[str, Any]] = None
        self._pending_event = threading.Event()
        self._active_context: Optional[Dict[str, Any]] = None
        self._active_background = False
        self._reset_preparers_pending = False
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def _on_engine_notification(
        self,
        method: str,
        params: Dict[str, Any],
        *,
        expected_generation: Optional[int] = None,
    ) -> None:
        if method == "task.status":
            state = str(params.get("state") or "")
            if state in ("queued", "running"):
                self._set_activity("running", expected_generation=expected_generation)
            elif state == "error":
                self._set_activity("error", str(params.get("message") or "引擎推理失败"), expected_generation=expected_generation)
            elif state in ("completed", "canceled"):
                self._set_activity("idle", expected_generation=expected_generation)
            return
        if method != "engine.status":
            return
        state = str(params.get("state") or "")
        if state in ("starting", "loading", "reloading"):
            self._set_activity("loading", expected_generation=expected_generation)
        elif state == "error":
            error = params.get("error") or {}
            self._set_activity(
                "error",
                str(error.get("message") or params.get("message") or "引擎错误"),
                expected_generation=expected_generation,
            )
        elif state in ("ready", "stopping", "stopped"):
            self._set_activity("idle", expected_generation=expected_generation)

    def cache_identity(self) -> str:
        return self._identity.cache_identity()

    def model_signature(self) -> str:
        return self._identity.model_signature

    @property
    def device_str(self) -> str:
        return "engine"

    def supported_input_modes(self) -> tuple[str, ...]:
        return self._identity.supported_input_modes

    def configure_profile(
        self,
        *,
        profile_id: str,
        engine_id: str,
        engine_version: str,
        model_id: str,
        model_format: str,
        model_path: str,
        expected_sha256: str = "",
        input_modes: Optional[list[str]] = None,
        engine_command: Optional[list[str]] = None,
        engine_cwd: Optional[str] = None,
        engine_options: Optional[Dict[str, Any]] = None,
        enabled_outputs: Optional[list[str]] = None,
        weights: Optional[list[Dict[str, Any]]] = None,
        engine_client: Optional[Any] = None,
    ) -> None:
        next_profile = OpponentEngineProfile.configured(
            profile_id=profile_id,
            engine_id=engine_id,
            engine_version=engine_version,
            model_id=model_id,
            model_format=model_format,
            model_path=model_path,
            expected_sha256=expected_sha256,
            input_modes=input_modes,
            engine_command=engine_command,
            engine_cwd=engine_cwd,
            engine_options=engine_options,
            enabled_outputs=enabled_outputs,
            weights=weights,
        )
        client_changed = (
            engine_client is not None and self._process_client is not engine_client
        )
        if (
            next_profile.identity_key() == self._profile.identity_key()
            and not client_changed
        ):
            return
        self._invalidate_initialization()
        self.cancel_all()
        self._runtime_notifications.detach()
        self._process_client.shutdown()
        self._profile = next_profile
        self._identity.reset(next_profile)
        if engine_client is not None:
            self._process_client = engine_client
            self._runtime_notifications.attach(engine_client)
        else:
            self._process_client = EngineProcessClient(
                "opponent-analysis",
                self._on_engine_notification,
                command=self._profile.engine_command or None,
                cwd=self._profile.engine_cwd or None,
                expected_engine_id=self._profile.engine_id,
                expected_engine_version=self._profile.engine_version,
            )
        self._model_ready = False
        with self._activity_lock:
            self._error_latched = False
            self._unloaded = True
        self._set_activity("idle")

    def _requested_output_contracts(self) -> list[Dict[str, Any]]:
        return self._profile.requested_output_contracts()

    def _analysis_output_references(self) -> list[Dict[str, Any]]:
        return self._identity.output_requests()

    def set_force_device(self, force_device: Optional[str]) -> None:
        """Forward a legacy device preference to engines that still support it."""
        configured_device = str(force_device or "auto")
        if configured_device not in ("auto", "cpu", "cuda"):
            configured_device = "auto"
        if configured_device == self._profile.device_preference:
            return
        self._invalidate_initialization()
        self.cancel_all()
        self._profile.device_preference = configured_device
        self._identity.clear_runtime()
        self._model_ready = False
        with self._activity_lock:
            self._response_times.clear()
            self._last_response_ms = 0.0
            self._error_latched = False
            self._unloaded = False
        with self._lock:
            self._latest["status"] = "loading"
        self._process_client.restart()
        self._set_activity("idle")

    def _is_initializing(self) -> bool:
        return not self._model_ready

    def set_activity_callback(self, callback: Optional[Callable[[str, Optional[str]], None]]) -> None:
        with self._activity_lock:
            self._activity_callback = callback

    def activity_state(self) -> str:
        with self._activity_lock:
            return self._activity_state

    def activity_error(self) -> Optional[str]:
        with self._activity_lock:
            return self._activity_error

    def runtime_status(self) -> Dict[str, Any]:
        return {
            "profileId": self._profile.profile_id,
            "ready": bool(self._model_ready),
            "unloaded": self._unloaded,
            "error": self.activity_error(),
        }

    def accepts_requests(self) -> bool:
        with self._activity_lock:
            return not self._error_latched and not self._unloaded

    def average_response_ms(self) -> float:
        with self._activity_lock:
            if not self._response_times:
                return 0.0
            return sum(self._response_times) / len(self._response_times)

    def last_response_ms(self) -> float:
        with self._activity_lock:
            return self._last_response_ms

    def _record_response_ms(self, elapsed_ms: float) -> None:
        with self._activity_lock:
            self._last_response_ms = float(elapsed_ms)
            self._response_times.append(self._last_response_ms)
            del self._response_times[:-10]

    @staticmethod
    def _format_error(prefix: str, error: Exception) -> str:
        detail = " ".join(str(error).split())
        return f"{prefix}：{detail or error.__class__.__name__}"[:240]

    def _set_activity(
        self,
        state: str,
        error: Optional[str] = None,
        *,
        latch_error: bool = True,
        expected_generation: Optional[int] = None,
    ) -> None:
        callback = None
        with self._activity_lock:
            if expected_generation is not None and expected_generation != self._lifecycle_generation:
                return
            if self._unloaded:
                state = "idle"
                error = None
            if state == "error" and latch_error:
                self._error_latched = True
            elif self._error_latched:
                return
            next_error = error if state == "error" else None
            if self._activity_state == state and self._activity_error == next_error:
                return
            self._activity_state = state
            self._activity_error = next_error
            callback = self._activity_callback
        if callback is not None:
            try:
                callback(state, next_error)
            except Exception:
                # The background worker must survive a closed event consumer.
                pass

    def prepare_reload(self) -> None:
        self._invalidate_initialization()
        self.cancel_all()
        self._model_ready = False
        self._identity.clear_runtime()
        with self._activity_lock:
            self._response_times.clear()
            self._last_response_ms = 0.0
            self._error_latched = False
            self._unloaded = False
        self._process_client.restart()
        self._set_activity("idle")

    def unload(self) -> None:
        self._invalidate_initialization()
        self.cancel_all()
        self._process_client.shutdown()
        self._model_ready = False
        self._identity.clear_runtime()
        with self._activity_lock:
            self._response_times.clear()
            self._last_response_ms = 0.0
            self._error_latched = False
            self._unloaded = True
        self._set_activity("idle")

    def _has_live_context(self) -> bool:
        with self._lock:
            return self._latest_context is not None

    def _invalidate_initialization(self) -> None:
        with self._lock:
            with self._activity_lock:
                self._lifecycle_generation += 1

    def prewarm(self) -> bool:
        """Load weights and complete one device forward pass without game input."""
        with self._activity_lock:
            if self._error_latched or self._unloaded:
                return False
        with self._initialization_lock:
            with self._activity_lock:
                if self._error_latched or self._unloaded:
                    return False
            return self._prewarm_locked()

    def _prewarm_locked(self) -> bool:
        with self._lock:
            generation = self._lifecycle_generation
        if self._model_ready:
            return True
        self._set_activity("loading", expected_generation=generation)
        try:
            requested_outputs = self._requested_output_contracts()
            initialization = initialize_engine_client(
                self._process_client,
                enabled_outputs=requested_outputs,
                weights=self._profile.configured_weights,
                device_preference=self._profile.device_preference,
                options=self._profile.engine_options,
                timeout=180,
            )
            revealed_supported = all(
                bool(initialization.contracts[output["id"]].get("supportsRevealedHands"))
                and bool(initialization.outputs[output["id"]].get("supportsRevealedHands"))
                for output in requested_outputs
            )
            with self._lock:
                if generation != self._lifecycle_generation:
                    return False
            effective_options = dict(initialization.result.get("effectiveOptions") or {})
            fingerprint = self._identity.calculate_cache_identity(
                initialization.protocol_minor,
                initialization.device,
                effective_options,
            )
            with self._lock:
                if generation != self._lifecycle_generation:
                    return False
                references = {
                    output_id: dict(initialization.references[output_id])
                    for output_id in self._profile.enabled_outputs
                }
                input_modes = (
                    ("public", "full-information") if revealed_supported else ("public",)
                )
                self._identity.accept_initialization(
                    references=references,
                    protocol_minor=initialization.protocol_minor,
                    input_modes=input_modes,
                    effective_options=effective_options,
                    actual_device=initialization.device,
                    fingerprint=fingerprint,
                )
                self._model_ready = True
                self._latest["status"] = "loaded"
            return True
        except Exception as exc:
            with self._lock:
                if generation != self._lifecycle_generation:
                    return False
            print(f"[SHANTEN] Prewarm failed: {exc}", flush=True)
            self._set_activity("error", self._format_error("模型预热失败", exc), expected_generation=generation)
            return False
        finally:
            with self._lock:
                has_work = self._pending is not None or self._active_context is not None
            if not has_work and self.activity_state() != "error":
                self._set_activity("idle", expected_generation=generation)

    def request_predict(
        self,
        snapshot: Dict[str, Any],
        controlled_seat: int,
        visible_hands: bool = False,
        input_mode: str = "public",
        context: Optional[Dict[str, Any]] = None,
        on_complete: Optional[Callable[[Dict[str, Any]], None]] = None,
        mjai_events: Optional[list[dict]] = None,
        mjai_prefix_hashes: Optional[list[int]] = None,
        mjai_events_hash: Optional[int] = None,
        target_mjai_events: Optional[list[dict]] = None,
        target_mjai_prefix_hashes: Optional[list[int]] = None,
        target_mjai_events_hash: Optional[int] = None,
        include_ground_truth: bool = True,
    ) -> None:
        del visible_hands
        with self._activity_lock:
            if self._error_latched or self._unloaded:
                return
        if input_mode not in self.supported_input_modes():
            raise ValueError(f"Unsupported opponent-analysis input mode: {input_mode}")
        has_prebuilt_streams = mjai_events is not None and (
            target_mjai_events is not None or not include_ground_truth
        )
        with self._lock:
            self._latest_context = copy.deepcopy(context or {})
            self._pending = {
                "snapshot": None if has_prebuilt_streams else copy.deepcopy(snapshot),
                "controlled_seat": int(controlled_seat),
                "input_mode": input_mode,
                "context": copy.deepcopy(context or {}),
                "on_complete": on_complete,
                "mjai_events": mjai_events,
                "mjai_prefix_hashes": mjai_prefix_hashes,
                "mjai_events_hash": mjai_events_hash,
                "target_mjai_events": target_mjai_events,
                "target_mjai_prefix_hashes": target_mjai_prefix_hashes,
                "target_mjai_events_hash": target_mjai_events_hash,
                "include_ground_truth": bool(include_ground_truth),
            }
            self._latest = {
                "predictions": {"opponents": {}, "ron_wait": {}},
                "ground_truth": {"opponents": {}, "ron_wait": {}},
                "context": copy.deepcopy(context or {}),
                "status": "loading",
            }
        initializing = self._is_initializing()
        self._set_activity("loading" if initializing else "running")
        self._pending_event.set()

    def request_background_predict(
        self,
        snapshot: Dict[str, Any],
        controlled_seat: int,
        input_mode: str = "public",
        context: Optional[Dict[str, Any]] = None,
        on_complete: Optional[Callable[[Dict[str, Any]], None]] = None,
        mjai_events: Optional[list[dict]] = None,
        mjai_prefix_hashes: Optional[list[int]] = None,
        mjai_events_hash: Optional[int] = None,
        target_mjai_events: Optional[list[dict]] = None,
        target_mjai_prefix_hashes: Optional[list[int]] = None,
        target_mjai_events_hash: Optional[int] = None,
        include_ground_truth: bool = True,
    ) -> bool:
        with self._activity_lock:
            if self._error_latched or self._unloaded:
                return False
        if input_mode not in self.supported_input_modes():
            raise ValueError(f"Unsupported opponent-analysis input mode: {input_mode}")
        request_context = copy.deepcopy(context or {})
        has_prebuilt_streams = mjai_events is not None and (
            target_mjai_events is not None or not include_ground_truth
        )
        with self._lock:
            if (
                (self._active_background and self._active_context == request_context)
                or any(item.get("context") == request_context for item in self._background_pending)
            ):
                return False
            self._background_pending.append(
                {
                    "snapshot": None if has_prebuilt_streams else copy.deepcopy(snapshot),
                    "controlled_seat": int(controlled_seat),
                    "input_mode": input_mode,
                    "context": request_context,
                    "on_complete": on_complete,
                    "background": True,
                    "mjai_events": mjai_events,
                    "mjai_prefix_hashes": mjai_prefix_hashes,
                    "mjai_events_hash": mjai_events_hash,
                    "target_mjai_events": target_mjai_events,
                    "target_mjai_prefix_hashes": target_mjai_prefix_hashes,
                    "target_mjai_events_hash": target_mjai_events_hash,
                    "include_ground_truth": bool(include_ground_truth),
                }
            )
        self._pending_event.set()
        return True

    def get_latest(self) -> Dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._latest)

    def has_request(self, context: Dict[str, Any]) -> bool:
        with self._lock:
            pending_context = self._pending.get("context") if self._pending else None
            active_context = None if self._active_background else self._active_context
            return pending_context == context or active_context == context

    def set_latest_context(self, context: Optional[Dict[str, Any]]) -> None:
        with self._lock:
            self._latest_context = copy.deepcopy(context) if context is not None else None
            if self._pending is not None and self._pending.get("context") != self._latest_context:
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
        if not has_active_request and self.activity_state() != "error":
            self._set_activity("idle")

    def cancel_background(self) -> None:
        with self._lock:
            self._background_pending.clear()
            has_foreground_work = self._pending is not None
            has_active_request = self._active_context is not None
            if not has_foreground_work:
                self._pending_event.clear()
        if not has_active_request and not has_foreground_work and self.activity_state() != "error":
            self._set_activity("idle")

    def cancel_all(self) -> None:
        with self._lock:
            self._latest_context = None
            self._pending = None
            self._background_pending.clear()
            self._pending_event.clear()
            self._reset_preparers_pending = True
            has_active_request = self._active_context is not None
        if not has_active_request and self.activity_state() != "error":
            self._set_activity("idle")

    def _is_superseded(self, context: Dict[str, Any]) -> bool:
        with self._lock:
            return self._latest_context != context

    def _run(self):
        while self._running:
            self._pending_event.wait()
            if not self._running:
                break
            pending = None
            reset_preparers = False
            with self._lock:
                if self._pending is not None:
                    pending = self._pending
                    self._pending = None
                elif self._background_pending:
                    pending = self._background_pending.popleft()
                if pending is not None:
                    self._active_context = copy.deepcopy(pending.get("context") or {})
                    self._active_background = bool(pending.get("background"))
                    reset_preparers = self._reset_preparers_pending
                    self._reset_preparers_pending = False
                self._pending_event.clear()

            if pending is None:
                continue
            if reset_preparers:
                pass

            initializing = self._is_initializing()
            self._set_activity("loading" if initializing else "running")
            try:
                if initializing:
                    if not self.prewarm():
                        raise RuntimeError(
                            self.activity_error() or "对手分析引擎初始化失败"
                        )
                prediction_started_at = time.perf_counter()

                snapshot = pending["snapshot"]
                c = pending["controlled_seat"]
                context = pending.get("context") or {}
                is_background = bool(pending.get("background"))
                input_mode = str(pending.get("input_mode") or "public")
                visibility_mode = "hidden" if input_mode == "public" else "full"
                if not is_background and self._is_superseded(context):
                    continue

                # The current model only accepts hidden-hand observations.
                from mjai_stream import build_mjai_stream
                events = pending.get("mjai_events")
                if events is None:
                    events = build_mjai_stream(snapshot, c, reveal_all=False)
                global _LATEST_OPPONENT_PREDICTION_MJAI
                _LATEST_OPPONENT_PREDICTION_MJAI = {
                    "events": events,
                    "seat": c,
                    "visibilityMode": visibility_mode,
                }

                include_ground_truth = bool(pending.get("include_ground_truth", True))
                target_events = pending.get("target_mjai_events")
                if include_ground_truth and target_events is None:
                    target_events = build_mjai_stream(snapshot, c, reveal_all=True)

                session_id = (
                    f"{context.get('gameId') or 'game'}:seat-{c}:"
                    f"opponent-analysis:{input_mode}"
                )
                worker_result = self._process_client.request(
                    "analysis.run",
                    {
                        "sessionId": session_id,
                        "controlledSeat": c,
                        "inputMode": (
                            "revealed" if input_mode == "full-information" else "standard"
                        ),
                        "events": events,
                        "outputs": [
                            {**output, "parameters": {}}
                            for output in self._analysis_output_references()
                        ],
                    },
                    timeout=180 if initializing else 30,
                )
                players = self._protocol_adapter.validate_prediction(
                    worker_result,
                    controlled_seat=c,
                    enabled_outputs=self._profile.enabled_outputs,
                    output_references=self._identity.output_references,
                )
                protocol_outputs = {
                    str(output.get("id") or ""): copy.deepcopy(output.get("data"))
                    for output in worker_result.get("outputs", [])
                    if isinstance(output, dict) and isinstance(output.get("data"), dict)
                }
                result = self._protocol_adapter.to_host_result(
                    players,
                    protocol_outputs=protocol_outputs,
                    controlled_seat=c,
                    context=context,
                    engine_fingerprint=self._identity.engine_fingerprint,
                    target_events=target_events,
                )
                if not is_background and self._is_superseded(context):
                    continue
                if not is_background:
                    with self._lock:
                        if self._latest_context != context:
                            continue
                        self._latest = result
                timing = worker_result.get("timing")
                worker_response_ms = timing.get("totalMs") if isinstance(timing, dict) else None
                self._record_response_ms(
                    float(worker_response_ms)
                    if isinstance(worker_response_ms, (int, float))
                    else (time.perf_counter() - prediction_started_at) * 1000
                )
                on_complete = pending.get("on_complete")
                if callable(on_complete):
                    try:
                        on_complete(copy.deepcopy(result))
                    except Exception as callback_error:  # pylint: disable=broad-except
                        print(
                            f"[SHANTEN] Cache callback failed: {callback_error}",
                            flush=True,
                        )
                continue
            except Exception as exc:
                if not pending.get("background") and self._is_superseded(pending.get("context") or {}):
                    continue
                import traceback
                print(f"[SHANTEN] Prediction error: {exc}", flush=True)
                traceback.print_exc()
                self._set_activity(
                    "error",
                    self._format_error("模型推理失败", exc),
                    latch_error=False,
                )
                error_result = {
                    "predictions": {"opponents": {}, "ron_wait": {}},
                    "ground_truth": {"opponents": {}, "ron_wait": {}},
                    "context": copy.deepcopy(pending.get("context") or {}),
                    "status": f"prediction_error: {exc}",
                }
                if not pending.get("background"):
                    with self._lock:
                        if self._latest_context != (pending.get("context") or {}):
                            continue
                        self._latest = error_result
                on_complete = pending.get("on_complete")
                if callable(on_complete):
                    try:
                        on_complete(copy.deepcopy(error_result))
                    except Exception as callback_error:  # pylint: disable=broad-except
                        print(f"[SHANTEN] Cache callback failed: {callback_error}", flush=True)
            finally:
                with self._lock:
                    self._active_context = None
                    self._active_background = False
                    has_pending = self._pending is not None or bool(self._background_pending)
                    if has_pending:
                        self._pending_event.set()
                if not has_pending and self.activity_state() != "error":
                    self._set_activity("idle")

    def shutdown(self):
        self._invalidate_initialization()
        self._runtime_notifications.detach()
        self._running = False
        self._pending_event.set()
        self._process_client.shutdown()
