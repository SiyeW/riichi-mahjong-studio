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
    _RESULT_SEMANTICS_VERSION = "decision-probabilities-v1"

    def __init__(self) -> None:
        self._device = "auto"
        self._profile_id = ""
        self._engine_id = ""
        self._engine_version = ""
        self._model_id = ""
        self._model_format = ""
        self._expected_sha256 = ""
        self._configured_model_path: Optional[str] = None
        self._model_hash_cache: Optional[tuple[str, int, int, str]] = None
        self._last_fingerprint = ""
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
        self._unloaded = False
        self._activity_callback: Optional[
            Callable[[int, str, Optional[str]], None]
        ] = None
        self._active_seat = 0
        self._response_times: list[float] = []
        self._client = EngineProcessClient(
            "decision",
            self._on_engine_notification,
            expected_engine_id=self._engine_id,
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
        engine_command: Optional[List[str]] = None,
        engine_cwd: Optional[str] = None,
        engine_options: Optional[Dict[str, Any]] = None,
    ) -> None:
        next_model_path = str(model_path) if model_path else None
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
        ) = next_config
        self._engine_command = list(command_parts) or None
        self._engine_cwd = engine_cwd_value or None
        self._engine_options = json.loads(engine_options_json)
        self._configured_model_path = model_path_value or None
        self._external_engine = bool(self._engine_command)
        self._client = EngineProcessClient(
            self._engine_kind,
            self._on_engine_notification,
            command=self._engine_command,
            cwd=self._engine_cwd,
            expected_engine_id=self._engine_id,
        )
        self._ready_models.clear()
        self._last_fingerprint = ""
        self._model_hash_cache = None
        with self._lock:
            self._response_times.clear()
            self._error_latched = False
            self._unloaded = False
        self._set_activity(self._active_seat, "idle")

    def _initialize(self, model_path: str, timeout: float) -> Dict[str, Any]:
        result = self._client.initialize(
            self._profile_id,
            "decision",
            model_path,
            model_id=self._model_id,
            model_format=self._model_format,
            expected_sha256=self._expected_sha256,
            device=self._device,
            options=self._engine_options,
            timeout=timeout,
        )
        actual_engine_id = str(result.get("engineId") or "")
        if actual_engine_id and actual_engine_id != self._engine_id:
            raise RuntimeError(
                f"engine identity mismatch: expected {self._engine_id}, "
                f"received {actual_engine_id}"
            )
        if self._external_engine and str(result.get("outputSchema") or "") != "decision-v1":
            raise RuntimeError("external decision engine must initialize with outputSchema=decision-v1")
        self._last_fingerprint = str(result.get("fingerprint") or "")
        return result

    def uses_generic_protocol(self) -> bool:
        return self._external_engine

    @staticmethod
    def _history_digest(events: List[Dict[str, Any]]) -> str:
        payload = json.dumps(
            events,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return f"sha256:{hashlib.sha256(payload).hexdigest()}"

    @staticmethod
    def _validate_generic_result(
        result: Dict[str, Any],
        candidate_ids: set[str],
        session_id: str,
        position_id: str,
        history_digest: str,
        engine_fingerprint: str,
    ) -> None:
        for field, expected in (
            ("sessionId", session_id),
            ("positionId", position_id),
            ("historyDigest", history_digest),
        ):
            if str(result.get(field) or "") != expected:
                raise RuntimeError(f"decision engine did not echo {field}")
        best_id = str(result.get("bestCandidateId") or "")
        if best_id not in candidate_ids:
            raise RuntimeError("decision engine returned an unknown bestCandidateId")
        if (
            not engine_fingerprint
            or str(result.get("engineFingerprint") or "") != engine_fingerprint
        ):
            raise RuntimeError("decision engine returned an unexpected engineFingerprint")
        choices = result.get("choices")
        if not isinstance(choices, list) or len(choices) != len(candidate_ids):
            raise RuntimeError("decision engine must score every legal candidate")
        seen: set[str] = set()
        probability_by_group: dict[str, float] = {}
        value_by_group: dict[str, float] = {}
        probability_count = 0
        for choice in choices:
            if not isinstance(choice, dict):
                raise RuntimeError("decision engine returned an invalid choice")
            candidate_id = str(choice.get("candidateId") or "")
            if candidate_id not in candidate_ids or candidate_id in seen:
                raise RuntimeError("decision engine returned duplicate or unknown candidateId")
            seen.add(candidate_id)
            raw_value = choice.get("rawValue")
            if not isinstance(raw_value, (int, float)) or not math.isfinite(raw_value):
                raise RuntimeError("decision engine returned an invalid rawValue")
            score_group_id = str(choice.get("scoreGroupId") or candidate_id)
            if not score_group_id:
                raise RuntimeError("decision engine returned an invalid scoreGroupId")
            previous_value = value_by_group.get(score_group_id)
            if previous_value is not None and abs(previous_value - float(raw_value)) > 1e-9:
                raise RuntimeError("decision engine returned inconsistent rawValue for a score group")
            value_by_group[score_group_id] = float(raw_value)
            if "probability" in choice:
                probability = choice.get("probability")
                if (
                    not isinstance(probability, (int, float))
                    or not math.isfinite(probability)
                    or probability < 0
                    or probability > 1
                ):
                    raise RuntimeError("decision engine returned an invalid probability")
                previous_probability = probability_by_group.get(score_group_id)
                if (
                    previous_probability is not None
                    and abs(previous_probability - float(probability)) > 1e-9
                ):
                    raise RuntimeError("decision engine returned inconsistent probability for a score group")
                probability_by_group[score_group_id] = float(probability)
                probability_count += 1
        if probability_count != len(candidate_ids):
            raise RuntimeError("decision engine must return probability for every candidate")
        if probability_by_group and abs(sum(probability_by_group.values()) - 1.0) > 1e-4:
            raise RuntimeError("decision engine probabilities do not sum to 1")

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
        history_digest = self._history_digest(mjai_events)
        stable_position_id = str(position_id or history_digest)
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
                "decision.analyze",
                {
                    "sessionId": session_id,
                    "positionId": stable_position_id,
                    "historyDigest": history_digest,
                    "seat": int(player_id),
                    "role": str(role),
                    "priority": str(priority),
                    "events": mjai_events,
                    "candidates": candidates,
                },
                timeout=120 if initializing else 30,
            )
            self._validate_generic_result(
                result,
                candidate_ids,
                session_id,
                stable_position_id,
                history_digest,
                self._last_fingerprint,
            )
            normalized = dict(result)
            normalized["engineFingerprint"] = str(
                result.get("engineFingerprint")
                or self._last_fingerprint
                or ""
            )
            normalized["engineId"] = self._engine_id
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

    def cache_identity(self, model_path: Optional[str] = None) -> str:
        if self._last_fingerprint:
            return self._last_fingerprint
        resolved_model_path = model_path or self._configured_model_path
        source = {
            "engineId": self._engine_id,
            "version": self._engine_version,
            "protocolMajor": 1,
            "modelSha256": self._model_sha256(resolved_model_path),
            "options": self._engine_options,
            "outputSchema": "decision-v1",
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
        with self._lock:
            if self._error_latched or self._unloaded:
                raise RuntimeError(self._activity_error or "决策引擎处于错误状态")
        resolved_model_path = to_relative_model_path(str(model_path))
        key = resolved_model_path
        initializing = key not in self._ready_models
        self._set_activity(player_id, "loading" if initializing else "running")
        started_at = time.perf_counter()
        try:
            if initializing:
                self._initialize(resolved_model_path, 120)
                self._ready_models = {key}
            result = self._client.request(
                "decision.analyze",
                {
                    "sessionId": f"decision:seat-{int(player_id)}:{role}",
                    "seat": int(player_id),
                    "role": str(role or "analysis"),
                    "events": mjai_events,
                    "eventPrefixHashes": event_prefix_hashes,
                    "eventHash": event_hash,
                },
                timeout=120 if initializing else 30,
            )
            response = result.get("response")
            if not isinstance(response, dict):
                raise RuntimeError("Decision engine returned no response")
            response = dict(response)
            response["engineFingerprint"] = str(
                result.get("engineFingerprint")
                or self._last_fingerprint
                or ""
            )
            response["engineId"] = self._engine_id
            timing = response.get("timing")
            elapsed_ms = (
                float(timing.get("total_ms"))
                if isinstance(timing, dict)
                and isinstance(timing.get("total_ms"), (int, float))
                else (time.perf_counter() - started_at) * 1000
            )
            self._record_response_ms(elapsed_ms)
            return response
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
