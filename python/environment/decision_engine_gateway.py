"""Process-isolated decision-engine gateway used for teaching and play."""

from __future__ import annotations

import hashlib
import json
import math
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from engine_process_client import EngineProcessClient
from decision_adapter import to_relative_model_path


class DecisionEngineGateway:
    _RESULT_SEMANTICS_VERSION = "action-recommendation-host-v4"
    _OUTPUT = {"id": "action-recommendation", "version": 1}

    def __init__(self) -> None:
        self._device = "auto"
        self._profile_id = ""
        self._engine_id = ""
        self._engine_version = ""
        self._model_id = ""
        self._model_format = ""
        self._expected_sha256 = ""
        self._configured_model_path: Optional[str] = None
        self._configured_weights: List[Dict[str, str]] = []
        self._model_hash_cache: Optional[tuple[str, int, int, str]] = None
        self._last_fingerprint = ""
        self._effective_options: Dict[str, Any] = {}
        self._actual_device = ""
        self._action_metrics: List[Dict[str, Any]] = []
        self._primary_metric_id = ""
        self._recommendation_metric_id = ""
        self._engine_kind = "decision"
        self._engine_command: Optional[List[str]] = None
        self._engine_cwd: Optional[str] = None
        self._engine_options: Dict[str, Any] = {"temperature": 1.0}
        self._external_engine = False
        self._ready_models: set[str] = set()
        self._lock = threading.Lock()
        self._activity_state = "idle"
        self._activity_error: Optional[str] = None
        self._error_latched = False
        self._unloaded = True
        self._activity_callback: Optional[
            Callable[[int, str, Optional[str]], None]
        ] = None
        self._active_seat = 0
        self._response_times: list[float] = []
        self._client = EngineProcessClient(
            "decision",
            self._on_engine_notification,
            expected_engine_id=self._engine_id,
            expected_engine_version=self._engine_version,
        )

    def configure_profile(
        self,
        *,
        profile_id: str,
        engine_id: str,
        engine_version: str = "1.0.0",
        model_id: str,
        model_format: str,
        expected_sha256: str = "",
        model_path: Optional[str] = None,
        weights: Optional[List[Dict[str, Any]]] = None,
        engine_command: Optional[List[str]] = None,
        engine_cwd: Optional[str] = None,
        engine_options: Optional[Dict[str, Any]] = None,
    ) -> None:
        next_model_path = str(model_path) if model_path else None
        normalized_weights = [
            {
                "slotId": str(weight.get("slotId") or ""),
                "format": str(weight.get("format") or ""),
                "path": str(weight.get("path") or ""),
            }
            for weight in (weights or [])
            if isinstance(weight, dict)
        ]
        if not normalized_weights and next_model_path:
            normalized_weights = [{
                "slotId": "model",
                "format": str(model_format),
                "path": next_model_path,
            }]
        engine_kind = "decision"
        normalized_engine_options = dict(engine_options or {})
        configured_device = str(
            normalized_engine_options.pop("device", "auto") or "auto"
        )
        if configured_device not in ("auto", "cpu", "cuda"):
            configured_device = "auto"
        next_config = (
            str(profile_id),
            str(engine_id),
            str(engine_version or "1.0.0"),
            str(model_id),
            str(model_format),
            str(expected_sha256 or "").lower(),
            engine_kind,
            configured_device,
            tuple(str(part) for part in (engine_command or [])),
            str(engine_cwd or ""),
            json.dumps(
                normalized_engine_options,
                sort_keys=True,
                separators=(",", ":"),
            ),
            next_model_path or "",
            json.dumps(normalized_weights, sort_keys=True, separators=(",", ":")),
        )
        current_config = (
            self._profile_id,
            self._engine_id,
            self._engine_version,
            self._model_id,
            self._model_format,
            self._expected_sha256,
            self._engine_kind,
            self._device,
            tuple(self._engine_command or []),
            self._engine_cwd or "",
            json.dumps(self._engine_options, sort_keys=True, separators=(",", ":")),
            self._configured_model_path or "",
            json.dumps(self._configured_weights, sort_keys=True, separators=(",", ":")),
        )
        if next_config == current_config:
            return
        self._client.shutdown()
        (
            self._profile_id,
            self._engine_id,
            self._engine_version,
            self._model_id,
            self._model_format,
            self._expected_sha256,
            self._engine_kind,
            self._device,
            command_parts,
            engine_cwd_value,
            engine_options_json,
            model_path_value,
            weights_json,
        ) = next_config
        self._engine_command = list(command_parts) or None
        self._engine_cwd = engine_cwd_value or None
        self._engine_options = json.loads(engine_options_json)
        self._configured_model_path = model_path_value or None
        self._configured_weights = json.loads(weights_json)
        self._external_engine = bool(self._engine_command)
        self._client = EngineProcessClient(
            self._engine_kind,
            self._on_engine_notification,
            command=self._engine_command,
            cwd=self._engine_cwd,
            expected_engine_id=self._engine_id,
            expected_engine_version=self._engine_version,
        )
        self._ready_models.clear()
        self._last_fingerprint = ""
        self._effective_options = {}
        self._actual_device = ""
        self._action_metrics = []
        self._primary_metric_id = ""
        self._recommendation_metric_id = ""
        self._model_hash_cache = None
        with self._lock:
            self._response_times.clear()
            self._error_latched = False
            self._unloaded = True
        self._set_activity(self._active_seat, "idle")

    def _initialize(self, model_path: str, timeout: float) -> Dict[str, Any]:
        hello = self._client.describe()
        initialized_weights = self._configured_weights or [{
            "slotId": "model",
            "format": self._model_format,
            "path": model_path,
        }]
        output_contracts = hello.get("outputContracts") or []
        action_contract = next(
            (
                output
                for output in output_contracts
                if isinstance(output, dict)
                and output.get("id") == self._OUTPUT["id"]
                and output.get("version") == self._OUTPUT["version"]
            ),
            None,
        )
        if action_contract is None:
            raise RuntimeError("engine does not provide action-recommendation version 1")
        slots = {
            str(slot.get("id") or ""): slot
            for slot in hello.get("weightSlots") or []
            if isinstance(slot, dict)
        }
        configured_by_slot = {
            weight["slotId"]: weight for weight in initialized_weights
        }
        for slot_id, weight in configured_by_slot.items():
            slot = slots.get(slot_id)
            formats = slot.get("formats") if isinstance(slot, dict) else None
            if not isinstance(formats, list) or not any(
                isinstance(item, dict) and item.get("id") == weight["format"]
                for item in formats
            ):
                raise RuntimeError(f"engine does not accept the configured {slot_id} weight")
        for slot_id, slot in slots.items():
            required = slot.get("requiredForOutputs") or []
            if any(
                item.get("id") == self._OUTPUT["id"]
                and item.get("version") == self._OUTPUT["version"]
                for item in required
                if isinstance(item, dict)
            ) and slot_id not in configured_by_slot:
                raise RuntimeError(f"engine requires the {slot_id} weight")
        device_types = [
            str(item.get("type") or "")
            for item in hello.get("devices") or []
            if isinstance(item, dict) and item.get("type")
        ]
        selected_device = self._device if self._device in device_types else ""
        if not selected_device:
            selected_device = device_types[0] if device_types else ""
        if not selected_device:
            raise RuntimeError("engine did not declare a usable device")
        result = self._client.initialize(
            [dict(self._OUTPUT)],
            [dict(weight) for weight in initialized_weights],
            device=selected_device,
            options=self._engine_options,
            timeout=timeout,
        )
        outputs = result.get("outputs")
        if not isinstance(outputs, list) or len(outputs) != 1:
            raise RuntimeError("engine initialization returned unexpected outputs")
        initialized_output = outputs[0]
        if not isinstance(initialized_output, dict) or any(
            initialized_output.get(key) != value for key, value in self._OUTPUT.items()
        ):
            raise RuntimeError("engine did not initialize action-recommendation version 1")
        metrics = initialized_output.get("metrics")
        self._action_metrics = [dict(item) for item in metrics] if isinstance(metrics, list) else []
        self._primary_metric_id = str(initialized_output.get("primaryMetricId") or "")
        self._recommendation_metric_id = str(initialized_output.get("recommendationMetricId") or "")
        metric_ids = [str(metric.get("id") or "") for metric in self._action_metrics]
        if any(not metric_id for metric_id in metric_ids) or len(set(metric_ids)) != len(metric_ids):
            raise RuntimeError("decision engine initialized invalid metric declarations")
        hello_metrics = {
            str(metric.get("id") or ""): metric
            for metric in action_contract.get("metrics") or []
            if isinstance(metric, dict)
        }
        for metric in self._action_metrics:
            metric_id = str(metric.get("id") or "")
            fraction_digits = metric.get("fractionDigits")
            if (
                metric_id not in hello_metrics
                or metric.get("format") not in ("number", "percentage", "points")
                or metric.get("preferredDirection") not in ("higher", "lower", "none")
                or not isinstance(metric.get("title"), dict)
                or (
                    fraction_digits is not None
                    and (
                        isinstance(fraction_digits, bool)
                        or not isinstance(fraction_digits, int)
                        or not 0 <= fraction_digits <= 12
                    )
                )
            ):
                raise RuntimeError(f"decision engine initialized invalid metric {metric_id}")
            declared = hello_metrics[metric_id]
            for key in (
                "title",
                "description",
                "format",
                "preferredDirection",
                "fractionDigits",
            ):
                if declared.get(key) != metric.get(key):
                    raise RuntimeError(f"decision engine changed initialized metric {metric_id}")
        if self._primary_metric_id and self._primary_metric_id not in metric_ids:
            raise RuntimeError("decision engine initialized an unknown primaryMetricId")
        if self._recommendation_metric_id:
            recommendation_metric = next((
                metric
                for metric in self._action_metrics
                if metric.get("id") == self._recommendation_metric_id
            ), None)
            if (
                recommendation_metric is None
                or recommendation_metric.get("format") != "percentage"
                or recommendation_metric.get("preferredDirection") != "higher"
            ):
                raise RuntimeError("decision engine initialized an invalid recommendationMetricId")
        self._effective_options = dict(result.get("effectiveOptions") or {})
        self._actual_device = str((result.get("device") or {}).get("type") or selected_device)
        self._last_fingerprint = ""
        self._last_fingerprint = self.cache_identity(model_path)
        return result

    def uses_generic_protocol(self) -> bool:
        return self._external_engine

    @staticmethod
    def _validate_generic_result(
        result: Dict[str, Any],
        candidate_ids: set[str],
        metric_definitions: List[Dict[str, Any]],
        primary_metric_id: str,
        recommendation_metric_id: str,
    ) -> Dict[str, Any]:
        outputs = result.get("outputs")
        if not isinstance(outputs, list) or len(outputs) != 1:
            raise RuntimeError("decision engine must return exactly one output")
        output = outputs[0]
        if (
            not isinstance(output, dict)
            or output.get("id") != "action-recommendation"
            or output.get("version") != 1
            or not isinstance(output.get("data"), dict)
        ):
            raise RuntimeError("decision engine returned an unexpected output")
        data = output["data"]
        best_id = str(data.get("bestCandidateId") or "")
        if best_id not in candidate_ids:
            raise RuntimeError("decision engine returned an unknown bestCandidateId")
        metric_ids = [str(metric.get("id") or "") for metric in metric_definitions]
        metric_formats = {
            str(metric.get("id") or ""): str(metric.get("format") or "")
            for metric in metric_definitions
        }
        candidates = data.get("candidates")
        if not metric_ids:
            if candidates is not None:
                raise RuntimeError("decision engine returned candidates without declared metrics")
            return {
                "bestCandidateId": best_id,
                "choices": [
                    {
                        "candidateId": candidate_id,
                        "scoreGroupId": candidate_id,
                        "rawValue": None,
                        "probability": None,
                        "metrics": {},
                    }
                    for candidate_id in sorted(candidate_ids)
                ],
            }
        if candidates is None:
            raise RuntimeError("decision engine omitted candidates for declared metrics")
        if not isinstance(candidates, list) or len(candidates) != len(candidate_ids):
            raise RuntimeError("decision engine must cover every legal candidate")
        seen: set[str] = set()
        choices = []
        for candidate in candidates:
            if not isinstance(candidate, dict):
                raise RuntimeError("decision engine returned an invalid candidate result")
            candidate_id = str(candidate.get("candidateId") or "")
            if candidate_id not in candidate_ids or candidate_id in seen:
                raise RuntimeError("decision engine returned duplicate or unknown candidateId")
            seen.add(candidate_id)
            metrics = candidate.get("metrics")
            if not isinstance(metrics, dict):
                raise RuntimeError("decision engine candidate metrics must be an object")
            if set(metrics) != set(metric_ids):
                raise RuntimeError("decision engine candidate metrics do not match initialized metrics")
            for metric_id, value in metrics.items():
                if value is not None and (
                    isinstance(value, bool)
                    or not isinstance(value, (int, float))
                    or not math.isfinite(float(value))
                ):
                    raise RuntimeError(f"decision engine returned invalid metric {metric_id}")
                if (
                    value is not None
                    and metric_formats.get(metric_id) == "percentage"
                    and not 0 <= float(value) <= 1
                ):
                    raise RuntimeError(f"decision engine returned invalid percentage metric {metric_id}")
            raw_value = metrics.get(primary_metric_id) if primary_metric_id else None
            probability = metrics.get(recommendation_metric_id) if recommendation_metric_id else None
            choices.append({
                "candidateId": candidate_id,
                "scoreGroupId": candidate_id,
                "rawValue": float(raw_value) if raw_value is not None else None,
                "probability": float(probability) if probability is not None else None,
                "metrics": dict(metrics),
            })
        return {"bestCandidateId": best_id, "choices": choices}

    def analyze_candidates(
        self,
        player_id: int,
        model_path: str,
        role: str,
        mjai_events: List[Dict[str, Any]],
        legal_actions: List[Dict[str, Any]],
        *,
        position_id: str = "",
        priority: str = "interactive",
    ) -> Dict[str, Any]:
        del position_id, priority
        with self._lock:
            if self._error_latched or self._unloaded:
                raise RuntimeError(self._activity_error or "决策引擎未加载")
        if not self._external_engine:
            raise RuntimeError("generic decision protocol is only used by external engines")
        if not legal_actions:
            raise ValueError("decision engine requires at least one legal candidate")
        resolved_model_path = to_relative_model_path(str(model_path))
        initializing = resolved_model_path not in self._ready_models
        self._set_activity(player_id, "loading" if initializing else "running")
        started_at = time.perf_counter()
        session_id = f"decision:seat-{int(player_id)}:{role}"
        candidates = []
        candidate_ids: set[str] = set()
        for index, action in enumerate(legal_actions):
            candidate_id = str(action.get("id") or f"candidate:{index}")
            if candidate_id in candidate_ids:
                raise ValueError(f"duplicate legal candidate id: {candidate_id}")
            candidate_ids.add(candidate_id)
            engine_action = {
                key: value
                for key, value in action.items()
                if key not in ("id", "label")
            }
            candidates.append({
                "candidateId": candidate_id,
                "action": engine_action,
            })
        try:
            if initializing:
                self._initialize(resolved_model_path, 120)
                self._ready_models = {resolved_model_path}
            result = self._client.request(
                "analysis.run",
                {
                    "sessionId": session_id,
                    "controlledSeat": int(player_id),
                    "inputMode": "standard",
                    "events": mjai_events,
                    "outputs": [{
                        **self._OUTPUT,
                        "parameters": {"candidates": candidates},
                    }],
                },
                timeout=120 if initializing else 30,
            )
            normalized = self._validate_generic_result(
                result,
                candidate_ids,
                self._action_metrics,
                self._primary_metric_id,
                self._recommendation_metric_id,
            )
            normalized["engineFingerprint"] = self._last_fingerprint
            normalized["engineId"] = self._engine_id
            normalized["metricDefinitions"] = [dict(metric) for metric in self._action_metrics]
            normalized["primaryMetricId"] = self._primary_metric_id
            normalized["recommendationMetricId"] = self._recommendation_metric_id
            timing = result.get("timing")
            elapsed_ms = (
                float(timing.get("totalMs"))
                if isinstance(timing, dict)
                and isinstance(timing.get("totalMs"), (int, float))
                else (time.perf_counter() - started_at) * 1000
            )
            self._record_response_ms(elapsed_ms)
            return normalized
        except Exception as exc:
            self._set_activity(
                player_id,
                "error",
                self._format_error(
                    "模型加载失败" if initializing else "模型推理失败",
                    exc,
                ),
            )
            raise
        finally:
            if self.activity_state() != "error":
                self._set_activity(player_id, "idle")

    def _model_sha256(self, model_path: Optional[str]) -> str:
        if self._expected_sha256:
            return self._expected_sha256
        if not model_path:
            return "unknown"
        path = Path(to_relative_model_path(str(model_path))).resolve()
        try:
            stat = path.stat()
            cached = self._model_hash_cache
            if cached and cached[:3] == (str(path), stat.st_size, stat.st_mtime_ns):
                return cached[3]
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            value = digest.hexdigest()
            self._model_hash_cache = (str(path), stat.st_size, stat.st_mtime_ns, value)
            return value
        except OSError:
            return "missing"

    @staticmethod
    def _weight_sha256(path_value: str) -> str:
        try:
            digest = hashlib.sha256()
            with Path(path_value).resolve().open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            return digest.hexdigest()
        except OSError:
            return "missing"

    def cache_identity(self, model_path: Optional[str] = None) -> str:
        if self._last_fingerprint:
            return self._last_fingerprint
        resolved_model_path = model_path or self._configured_model_path
        configured_weights = self._configured_weights or ([{
            "slotId": "model",
            "format": self._model_format,
            "path": str(resolved_model_path or ""),
        }] if resolved_model_path else [])
        source = {
            "engineId": self._engine_id,
            "version": self._engine_version,
            "protocolMajor": 2,
            "weights": [
                {
                    "slotId": weight["slotId"],
                    "format": weight["format"],
                    "sha256": (
                        self._model_sha256(resolved_model_path)
                        if weight["path"] == resolved_model_path
                        else self._weight_sha256(weight["path"])
                    ),
                }
                for weight in configured_weights
            ],
            "device": self._actual_device or self._device,
            "options": self._effective_options or self._engine_options,
            "outputContract": self._OUTPUT,
            "metrics": [
                {
                    key: metric.get(key)
                    for key in (
                        "id",
                        "title",
                        "description",
                        "format",
                        "preferredDirection",
                        "fractionDigits",
                    )
                }
                for metric in self._action_metrics
            ],
            "primaryMetricId": self._primary_metric_id,
            "recommendationMetricId": self._recommendation_metric_id,
            "resultSemanticsVersion": self._RESULT_SEMANTICS_VERSION,
        }
        encoded = json.dumps(
            source,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
        return f"sha256:{hashlib.sha256(encoded).hexdigest()}"

    def _on_engine_notification(
        self,
        method: str,
        params: Dict[str, Any],
    ) -> None:
        if method == "task.status":
            seat = int(params.get("seat", self._active_seat))
            state = str(params.get("state") or "")
            mapped = "running" if state in ("queued", "running") else "idle"
            if state == "error":
                mapped = "error"
            self._set_activity(seat, mapped)
            return
        if method != "engine.status":
            return
        state = str(params.get("state") or "")
        if state in ("starting", "loading", "reloading"):
            self._set_activity(self._active_seat, "loading")
        elif state == "error":
            error = params.get("error") or {}
            self._set_activity(
                self._active_seat,
                "error",
                str(error.get("message") or params.get("message") or "引擎错误"),
            )
        elif state in ("ready", "stopping", "stopped"):
            self._set_activity(self._active_seat, "idle")

    @staticmethod
    def _format_error(prefix: str, error: Exception) -> str:
        detail = " ".join(str(error).split())
        return f"{prefix}：{detail or error.__class__.__name__}"[:240]

    def set_activity_callback(
        self,
        callback: Optional[Callable[[int, str, Optional[str]], None]],
    ) -> None:
        with self._lock:
            self._activity_callback = callback

    def _set_activity(
        self,
        seat: int,
        state: str,
        error: Optional[str] = None,
    ) -> None:
        callback = None
        with self._lock:
            if self._unloaded:
                state = "idle"
                error = None
            if state == "error":
                self._error_latched = True
            elif self._error_latched:
                return
            next_error = error if state == "error" else None
            changed = (
                self._activity_state != state
                or self._activity_error != next_error
                or self._active_seat != int(seat)
            )
            self._activity_state = state
            self._activity_error = next_error
            self._active_seat = int(seat)
            callback = self._activity_callback
        if changed and callback is not None:
            try:
                callback(int(seat), state, next_error)
            except Exception:
                pass

    def activity_state(self) -> str:
        with self._lock:
            return self._activity_state

    def activity_error(self) -> Optional[str]:
        with self._lock:
            return self._activity_error

    def runtime_status(self) -> Dict[str, Any]:
        model_path = self._configured_model_path
        ready = bool(
            model_path
            and to_relative_model_path(str(model_path)) in self._ready_models
        )
        return {
            "profileId": self._profile_id,
            "ready": ready,
            "unloaded": self._unloaded,
        }

    def accepts_requests(self) -> bool:
        with self._lock:
            return not self._error_latched and not self._unloaded

    def active_seat(self) -> int:
        with self._lock:
            return self._active_seat

    def average_response_ms(self) -> float:
        with self._lock:
            if not self._response_times:
                return 0.0
            return sum(self._response_times) / len(self._response_times)

    def _record_response_ms(self, elapsed_ms: float) -> None:
        with self._lock:
            self._response_times.append(float(elapsed_ms))
            del self._response_times[:-10]

    @property
    def device_str(self) -> str:
        return self._device

    def set_force_device(self, device: Optional[str]) -> None:
        self._device = "auto" if device is None else str(device)
        self._ready_models.clear()
        self._last_fingerprint = ""
        with self._lock:
            self._response_times.clear()
            self._error_latched = False
            self._unloaded = False
        self._client.restart()
        self._set_activity(self._active_seat, "idle")

    def prepare_reload(self) -> None:
        self._ready_models.clear()
        self._last_fingerprint = ""
        self._model_hash_cache = None
        with self._lock:
            self._response_times.clear()
            self._error_latched = False
            self._unloaded = False
        self._client.restart()
        self._set_activity(self._active_seat, "idle")

    def unload(self) -> None:
        self._client.shutdown()
        self._ready_models.clear()
        self._last_fingerprint = ""
        self._model_hash_cache = None
        with self._lock:
            self._response_times.clear()
            self._error_latched = False
            self._unloaded = True
        self._set_activity(self._active_seat, "idle")

    def prewarm(self, player_id: int, model_path: str) -> bool:
        with self._lock:
            if self._error_latched or self._unloaded:
                return False
        resolved_model_path = to_relative_model_path(str(model_path))
        key = resolved_model_path
        if key in self._ready_models:
            return True
        self._set_activity(player_id, "loading")
        try:
            self._initialize(resolved_model_path, 120)
            self._ready_models = {key}
            return True
        except Exception as exc:
            self._set_activity(
                player_id,
                "error",
                self._format_error("模型加载失败", exc),
            )
            return False
        finally:
            if self.activity_state() != "error":
                self._set_activity(player_id, "idle")

    def react(
        self,
        player_id: int,
        model_path: str,
        role: str,
        mjai_events: List[Dict[str, Any]],
        event_prefix_hashes: Optional[List[int]] = None,
        event_hash: Optional[int] = None,
    ) -> Dict[str, Any]:
        del player_id, model_path, role, mjai_events, event_prefix_hashes, event_hash
        raise RuntimeError("protocol 2 action requests require host-provided candidates")

    def reset_session(self) -> None:
        if not self._ready_models:
            self._set_activity(self._active_seat, "idle")
            return
        try:
            self._client.request(
                "session.reset",
                {"sessionId": "decision:all"},
                timeout=30,
            )
        except Exception:
            # A worker that has not started has no incremental state to reset.
            self._client.restart()
        self._set_activity(self._active_seat, "idle")

    def get_bot(
        self,
        player_id: int,
        model_path: str,
        role: str = "play",
    ):
        del role
        if not self.prewarm(player_id, model_path):
            raise RuntimeError(self.activity_error() or "Decision engine failed to load")
        return self

    def get_activity(self) -> List[str]:
        activity = ["idle", "idle", "idle", "idle"]
        activity[self.active_seat() % 4] = self.activity_state()
        return activity

    def get_activity_errors(self) -> List[Optional[str]]:
        errors: List[Optional[str]] = [None, None, None, None]
        error = self.activity_error()
        if error:
            errors[self.active_seat() % 4] = error
        return errors

    def shutdown(self) -> None:
        self._client.shutdown()
