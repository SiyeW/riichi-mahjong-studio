"""Adapt opponent prediction outputs to the host's analysis data."""
from __future__ import annotations

import copy
import threading
import time
from typing import Any, Callable, Dict, Optional

from engine_process_client import EngineProcessClient  # noqa: E402
from engine_runtime import initialize_engine_client
from engine_notification_subscription import EngineNotificationSubscription
from opponent_prediction_activity import OpponentPredictionActivity
from opponent_prediction_profile import (
    OpponentEngineIdentity,
    OpponentEngineProfile,
)
from opponent_prediction_protocol import OpponentPredictionProtocolAdapter
from opponent_prediction_requests import OpponentPredictionRequests

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
        self._initialization_state_lock = threading.Lock()
        self._notification_lock = threading.Lock()
        self._activity = OpponentPredictionActivity()
        self._runtime_notifications = EngineNotificationSubscription(
            self._notification_lock,
            lambda: self._process_client,
            lambda: self._activity.generation,
            lambda *args, **kwargs: self._on_engine_notification(*args, **kwargs),
        )
        self._requests = OpponentPredictionRequests(
            activity=self._activity,
            supported_input_modes=self.supported_input_modes,
            is_initializing=self._is_initializing,
            prewarm=self.prewarm,
            execute=self._execute_prediction,
            activity_error=self.activity_error,
            format_error=self._format_error,
        )

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
                self._set_activity(
                    "error",
                    str(params.get("message") or "引擎推理失败"),
                    expected_generation=expected_generation,
                )
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
        self._activity.reset(unloaded=True)

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
        self._activity.reset(unloaded=False)
        self._requests.mark_loading()
        self._process_client.restart()
        self._set_activity("idle")

    def _is_initializing(self) -> bool:
        return not self._model_ready

    def set_activity_callback(
        self,
        callback: Optional[Callable[[str, Optional[str]], None]],
    ) -> None:
        self._activity.set_callback(callback)

    def activity_state(self) -> str:
        return self._activity.state()

    def activity_error(self) -> Optional[str]:
        return self._activity.error()

    def runtime_status(self) -> Dict[str, Any]:
        return {
            "profileId": self._profile.profile_id,
            "ready": bool(self._model_ready),
            "unloaded": self._activity.is_unloaded(),
            "error": self.activity_error(),
        }

    def accepts_requests(self) -> bool:
        return self._activity.accepts_requests()

    def average_response_ms(self) -> float:
        return self._activity.average_response_ms()

    def last_response_ms(self) -> float:
        return self._activity.last_response_ms()

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
        self._activity.set(
            state,
            error,
            latch_error=latch_error,
            expected_generation=expected_generation,
        )

    def prepare_reload(self) -> None:
        self._invalidate_initialization()
        self.cancel_all()
        self._model_ready = False
        self._identity.clear_runtime()
        self._activity.reset(unloaded=False)
        self._process_client.restart()
        self._set_activity("idle")

    def unload(self) -> None:
        self._invalidate_initialization()
        self.cancel_all()
        self._process_client.shutdown()
        self._model_ready = False
        self._identity.clear_runtime()
        self._activity.reset(unloaded=True)
        self._set_activity("idle")

    def _invalidate_initialization(self) -> None:
        self._activity.invalidate()

    def prewarm(self) -> bool:
        """Load weights and complete one device forward pass without game input."""
        if not self._activity.can_initialize():
            return False
        with self._initialization_lock:
            if not self._activity.can_initialize():
                return False
            return self._prewarm_locked()

    def _prewarm_locked(self) -> bool:
        generation = self._activity.generation
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
            with self._initialization_state_lock:
                if generation != self._activity.generation:
                    return False
            effective_options = dict(initialization.result.get("effectiveOptions") or {})
            fingerprint = self._identity.calculate_cache_identity(
                initialization.protocol_minor,
                initialization.device,
                effective_options,
            )
            with self._initialization_state_lock:
                if generation != self._activity.generation:
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
                self._requests.mark_loaded()
            return True
        except Exception as exc:
            with self._initialization_state_lock:
                if generation != self._activity.generation:
                    return False
            print(f"[SHANTEN] Prewarm failed: {exc}", flush=True)
            self._set_activity(
                "error",
                self._format_error("模型预热失败", exc),
                expected_generation=generation,
            )
            return False
        finally:
            has_work = self._requests.has_work()
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
        self._requests.request_foreground(
            snapshot,
            controlled_seat,
            input_mode=input_mode,
            context=context,
            on_complete=on_complete,
            mjai_events=mjai_events,
            mjai_prefix_hashes=mjai_prefix_hashes,
            mjai_events_hash=mjai_events_hash,
            target_mjai_events=target_mjai_events,
            target_mjai_prefix_hashes=target_mjai_prefix_hashes,
            target_mjai_events_hash=target_mjai_events_hash,
            include_ground_truth=include_ground_truth,
        )

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
        return self._requests.request_background(
            snapshot,
            controlled_seat,
            input_mode=input_mode,
            context=context,
            on_complete=on_complete,
            mjai_events=mjai_events,
            mjai_prefix_hashes=mjai_prefix_hashes,
            mjai_events_hash=mjai_events_hash,
            target_mjai_events=target_mjai_events,
            target_mjai_prefix_hashes=target_mjai_prefix_hashes,
            target_mjai_events_hash=target_mjai_events_hash,
            include_ground_truth=include_ground_truth,
        )

    def get_latest(self) -> Dict[str, Any]:
        return self._requests.get_latest()

    def has_request(self, context: Dict[str, Any]) -> bool:
        return self._requests.has_request(context)

    def set_latest_context(self, context: Optional[Dict[str, Any]]) -> None:
        self._requests.set_latest_context(context)

    def cancel_pending(self) -> None:
        self._requests.cancel_pending()

    def cancel_background(self) -> None:
        self._requests.cancel_background()

    def cancel_all(self) -> None:
        self._requests.cancel_all()

    def _execute_prediction(
        self,
        pending: Dict[str, Any],
        initializing: bool,
    ) -> tuple[Dict[str, Any], float]:
        prediction_started_at = time.perf_counter()
        snapshot = pending["snapshot"]
        controlled_seat = pending["controlled_seat"]
        context = pending.get("context") or {}
        input_mode = str(pending.get("input_mode") or "public")
        visibility_mode = "hidden" if input_mode == "public" else "full"

        # The current model only accepts hidden-hand observations.
        from mjai_stream import build_mjai_stream

        events = pending.get("mjai_events")
        if events is None:
            events = build_mjai_stream(
                snapshot,
                controlled_seat,
                reveal_all=False,
            )
        global _LATEST_OPPONENT_PREDICTION_MJAI
        _LATEST_OPPONENT_PREDICTION_MJAI = {
            "events": events,
            "seat": controlled_seat,
            "visibilityMode": visibility_mode,
        }

        include_ground_truth = bool(
            pending.get("include_ground_truth", True)
        )
        target_events = pending.get("target_mjai_events")
        if include_ground_truth and target_events is None:
            target_events = build_mjai_stream(
                snapshot,
                controlled_seat,
                reveal_all=True,
            )

        session_id = (
            f"{context.get('gameId') or 'game'}:seat-{controlled_seat}:"
            f"opponent-analysis:{input_mode}"
        )
        worker_result = self._process_client.request(
            "analysis.run",
            {
                "sessionId": session_id,
                "controlledSeat": controlled_seat,
                "inputMode": (
                    "revealed"
                    if input_mode == "full-information"
                    else "standard"
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
            controlled_seat=controlled_seat,
            enabled_outputs=self._profile.enabled_outputs,
            output_references=self._identity.output_references,
        )
        protocol_outputs = {
            str(output.get("id") or ""): copy.deepcopy(output.get("data"))
            for output in worker_result.get("outputs", [])
            if isinstance(output, dict)
            and isinstance(output.get("data"), dict)
        }
        result = self._protocol_adapter.to_host_result(
            players,
            protocol_outputs=protocol_outputs,
            controlled_seat=controlled_seat,
            context=context,
            engine_fingerprint=self._identity.engine_fingerprint,
            target_events=target_events,
        )
        timing = worker_result.get("timing")
        worker_response_ms = (
            timing.get("totalMs") if isinstance(timing, dict) else None
        )
        elapsed_ms = (
            float(worker_response_ms)
            if isinstance(worker_response_ms, (int, float))
            else (time.perf_counter() - prediction_started_at) * 1000
        )
        return result, elapsed_ms

    def shutdown(self):
        self._invalidate_initialization()
        self._runtime_notifications.detach()
        self._requests.shutdown()
        self._process_client.shutdown()
