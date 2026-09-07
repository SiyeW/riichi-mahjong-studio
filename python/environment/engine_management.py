"""Engine configuration, runtime lifecycle and analysis-source ownership."""

from __future__ import annotations

import copy
import json
import os
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, MutableMapping, Optional

import engine_configuration
from analysis_cache import build_analysis_source
from engine_assignments import resolve_engine_assignments
from opponent_prediction_coordinator import ANALYSIS_OUTPUT_IDS
from service_helpers import now_iso


_DECISION_POSTPROCESSOR_VERSION = "decision-analysis-v2"


@dataclass(frozen=True)
class EngineLifecycleCallbacks:
    invalidate_analysis: Callable[[str], None]
    prepare_for_unload: Callable[[], None]
    build_state: Callable[[], dict[str, Any]]


class EngineManagement:
    """Own the active engine configuration and cache generations."""

    def __init__(
        self,
        state: MutableMapping[str, Any],
        *,
        project_root: Path,
        portable_root: Path,
        resource_root: Path,
        action_gateway: Any,
        opponent_predictions: Any,
        runtime_registry: Any,
        prewarm_executor: Any,
        emit: Callable[[dict[str, Any]], None],
        lifecycle: EngineLifecycleCallbacks,
    ) -> None:
        self.state = state
        self.project_root = Path(project_root).resolve()
        self.portable_root = Path(portable_root).resolve()
        self.resource_root = Path(resource_root).resolve()
        self.action_gateway = action_gateway
        self.opponent_predictions = opponent_predictions
        self.runtime_registry = runtime_registry
        self.prewarm_executor = prewarm_executor
        self.emit = emit
        self.lifecycle = lifecycle

        self._project_config_lock = threading.Lock()
        self._engine_config_lock = threading.Lock()
        self._cache_epoch_lock = threading.Lock()
        self._project_config_signature: Optional[tuple[Any, ...]] = None
        self._project_config_value: dict[str, Any] = {}
        self._runtime_engine_settings: Optional[dict[str, Any]] = None
        self._active_decision_source_id: Optional[str] = None
        self._active_opponent_source_id: Optional[str] = None
        self._decision_cache_epoch = 0
        self._opponent_cache_epoch = 0

        self.action_gateway.set_activity_callback(self._emit_decision_activity)
        self.opponent_predictions.set_activity_callback(
            self._emit_opponent_analysis_activity
        )

    @property
    def decision_cache_epoch(self) -> int:
        with self._cache_epoch_lock:
            return self._decision_cache_epoch

    @property
    def opponent_cache_epoch(self) -> int:
        with self._cache_epoch_lock:
            return self._opponent_cache_epoch

    def advance_cache_epochs(self) -> tuple[int, int]:
        with self._cache_epoch_lock:
            self._decision_cache_epoch += 1
            self._opponent_cache_epoch += 1
            return self._decision_cache_epoch, self._opponent_cache_epoch

    def reset_project_config_cache(self) -> None:
        with self._project_config_lock:
            self._project_config_signature = None
            self._project_config_value = {}

    @staticmethod
    def _load_json_file(path: Path) -> dict[str, Any]:
        if not path.exists():
            return {}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
        return value if isinstance(value, dict) else {}

    def project_config_paths(self) -> tuple[Path, ...]:
        configured_path = str(os.environ.get("MJAI_TRAINER_CONFIG") or "").strip()
        if configured_path:
            return (Path(configured_path).expanduser().resolve(),)
        if getattr(sys, "frozen", False):
            return (
                Path(sys.executable).resolve().parent / "config.json",
                self.portable_root / "config.json",
            )
        return (self.project_root / "config.json",)

    def load_project_config(self) -> dict[str, Any]:
        paths = self.project_config_paths()
        signature = []
        for path in paths:
            try:
                stat = path.stat()
                signature.append((str(path), stat.st_mtime_ns, stat.st_size))
            except OSError:
                signature.append((str(path), None, None))
        resolved_signature = tuple(signature)

        with self._project_config_lock:
            if resolved_signature == self._project_config_signature:
                return self._project_config_value

            base = self._load_json_file(paths[0])
            if len(paths) > 1:
                user = self._load_json_file(paths[1])
                for key in ("training", "modeDefaults", "audio", "engines"):
                    if key in user:
                        base[key] = user[key]
            self._project_config_signature = resolved_signature
            self._project_config_value = base
            return self._project_config_value

    def runtime_engine_config(self) -> dict[str, Any]:
        if isinstance(self._runtime_engine_settings, dict):
            return {"engines": self._runtime_engine_settings}
        return self.load_project_config()

    def training_config(self) -> dict[str, Any]:
        return engine_configuration.training_config(self.load_project_config())

    def resolve_resource_path(self, path_value: Any) -> str:
        return engine_configuration.resolve_resource_path(
            path_value,
            project_root=self.resource_root,
            frozen=getattr(sys, "frozen", False),
            executable=sys.executable,
        )

    def action_weight_path(self) -> str:
        return engine_configuration.action_engine_weight_path(
            self.runtime_engine_config(),
            self.resolve_resource_path,
        )

    def source_display_name(self, kind: str) -> str:
        config = self.load_project_config()
        output_ids = (
            {"action-recommendation"}
            if kind == "decision"
            else set(ANALYSIS_OUTPUT_IDS)
        )
        names = []
        for assignment in resolve_engine_assignments(config, loaded_only=True):
            if not output_ids.intersection(assignment["outputs"]):
                continue
            profile = assignment["profile"]
            name = str(
                profile.get("name")
                or profile.get("engineId")
                or assignment["profileId"]
            )
            if name and name not in names:
                names.append(name)
        return " + ".join(names) or str(kind)

    def decision_source(
        self,
        model_path: Optional[str] = None,
        *,
        include_display_name: bool = False,
    ) -> dict[str, Any]:
        return build_analysis_source(
            "decision",
            self.action_gateway.cache_identity(model_path),
            _DECISION_POSTPROCESSOR_VERSION,
            "action-recommendation",
            display_name=(
                self.source_display_name("decision")
                if include_display_name
                else "决策引擎"
            ),
        )

    def opponent_source(
        self,
        *,
        include_display_name: bool = False,
    ) -> dict[str, Any]:
        config = self.load_project_config()
        assigned_outputs = {
            output_id
            for assignment in resolve_engine_assignments(config)
            for output_id in assignment["outputs"]
        }
        output_signature = "+".join(
            output_id
            for output_id in ANALYSIS_OUTPUT_IDS
            if output_id in assigned_outputs
        ) or "opponent-analysis"
        return build_analysis_source(
            "opponent",
            self.opponent_predictions.cache_identity(),
            None,
            output_signature,
            display_name=(
                self.source_display_name("opponent")
                if include_display_name
                else "Opponent analysis"
            ),
        )

    def _gateway_profile(
        self,
        config: dict[str, Any],
        output_id: str,
    ) -> Optional[dict[str, Any]]:
        return engine_configuration.gateway_profile(
            config,
            output_id,
            self.resolve_resource_path,
        )

    def _configure_action_gateway(self, config: dict[str, Any]) -> None:
        selected = self._gateway_profile(config, "action-recommendation") or {}
        engine_client = self.runtime_registry.get(selected.get("profile_id"))
        self.action_gateway.configure_profile(
            profile_id=str(selected.get("profile_id") or ""),
            engine_id=str(selected.get("engine_id") or ""),
            engine_version=str(selected.get("engine_version") or ""),
            model_id=str(selected.get("model_id") or ""),
            model_format=str(selected.get("model_format") or ""),
            expected_sha256=str(selected.get("expected_sha256") or ""),
            model_path=str(selected.get("model_path") or "") or None,
            weights=selected.get("weights") or [],
            engine_command=selected.get("engine_command") or [],
            engine_cwd=selected.get("engine_cwd"),
            engine_options=selected.get("engine_options") or {},
            engine_client=engine_client,
        )

    def _configure_opponent_predictions(self, config: dict[str, Any]) -> None:
        profiles = {}
        for output_id in ANALYSIS_OUTPUT_IDS:
            profile = self._gateway_profile(config, output_id)
            if not profile:
                continue
            profile["input_modes"] = ["public"]
            profile["engine_client"] = self.runtime_registry.get(
                profile["profile_id"]
            )
            profiles[output_id] = profile
        self.opponent_predictions.configure_profiles(profiles)

    def apply_runtime_config(
        self,
        config: Optional[dict[str, Any]] = None,
        *,
        invalidate: bool = False,
    ) -> bool:
        with self._engine_config_lock:
            resolved = config if isinstance(config, dict) else self.load_project_config()
            specifications = engine_configuration.runtime_specifications(
                resolved,
                self.resolve_resource_path,
            )
            self.runtime_registry.reconcile(specifications)
            self._configure_action_gateway(resolved)
            self._configure_opponent_predictions(resolved)

            engines = resolved.get("engines")
            self._runtime_engine_settings = (
                copy.deepcopy(engines) if isinstance(engines, dict) else {}
            )

            decision_source_id = self.decision_source()["id"]
            opponent_source_id = self.opponent_source()["id"]
            source_changed = (
                self._active_decision_source_id is not None
                and self._active_decision_source_id != decision_source_id
            ) or (
                self._active_opponent_source_id is not None
                and self._active_opponent_source_id != opponent_source_id
            )
            self._active_decision_source_id = decision_source_id
            self._active_opponent_source_id = opponent_source_id

        if invalidate and source_changed:
            self.advance_cache_epochs()
            self.lifecycle.invalidate_analysis("分析模型已更改")
        return source_changed

    def prewarm(self, profile_id: str = "") -> dict[str, Any]:
        requested_profile_id = str(profile_id or "")
        action_weight_path = self.action_weight_path()
        warmed = {
            "teachingAnalysis": False,
            "teachingPlay": False,
            "opponentPlay": False,
            "opponentAnalysis": False,
        }
        errors = {}
        decision_profile_id = str(
            self.action_gateway.runtime_status().get("profileId") or ""
        )
        opponent_profile_ids = set(
            self.opponent_predictions.runtime_status().get("profileIds") or []
        )
        should_prewarm_decision = bool(decision_profile_id) and (
            not requested_profile_id or decision_profile_id == requested_profile_id
        )
        should_prewarm_opponent = bool(opponent_profile_ids) and (
            not requested_profile_id or requested_profile_id in opponent_profile_ids
        )

        def prewarm_decision() -> tuple[bool, Optional[str]]:
            if not self.action_gateway.runtime_status().get("profileId"):
                return False, None
            try:
                ready = self.action_gateway.prewarm(0, action_weight_path)
                error = (
                    None
                    if ready
                    else self.action_gateway.activity_error() or "决策引擎预热失败"
                )
                return ready, error
            except Exception as error:  # pylint: disable=broad-except
                return False, str(error)
            finally:
                self._emit_decision_activity(
                    self.action_gateway.active_seat(),
                    self.action_gateway.activity_state(),
                    self.action_gateway.activity_error(),
                )

        def prewarm_opponent() -> tuple[bool, Optional[str]]:
            if not self.opponent_predictions.runtime_status().get("profileId"):
                return False, None
            try:
                ready = self.opponent_predictions.prewarm(requested_profile_id or None)
                error = (
                    None
                    if ready
                    else self.opponent_predictions.activity_error()
                    or "对手分析引擎预热失败"
                )
                return ready, error
            except Exception as error:  # pylint: disable=broad-except
                return False, str(error)
            finally:
                self._emit_opponent_analysis_activity(
                    self.opponent_predictions.activity_state(),
                    self.opponent_predictions.activity_error(),
                )

        decision_future = (
            self.prewarm_executor.submit(prewarm_decision)
            if should_prewarm_decision
            else None
        )
        opponent_future = (
            self.prewarm_executor.submit(prewarm_opponent)
            if should_prewarm_opponent
            else None
        )
        decision_ready, decision_error = (
            decision_future.result() if decision_future else (False, None)
        )
        opponent_ready, opponent_error = (
            opponent_future.result() if opponent_future else (False, None)
        )

        warmed["teachingAnalysis"] = decision_ready
        warmed["teachingPlay"] = decision_ready
        warmed["opponentPlay"] = decision_ready
        warmed["opponentAnalysis"] = opponent_ready
        if decision_error:
            errors["decision"] = decision_error
        if opponent_error:
            errors["opponent-analysis"] = opponent_error
        return {
            "warmed": warmed,
            "device": self.action_gateway.device_str,
            "errors": errors,
        }

    def reload(self, profile_id: str) -> dict[str, Any]:
        requested_profile_id = str(profile_id or "")
        if not requested_profile_id:
            raise ValueError("engine profile id is required")
        self.apply_runtime_config(self.load_project_config(), invalidate=True)
        matched = False
        if (
            str(self.action_gateway.runtime_status().get("profileId") or "")
            == requested_profile_id
        ):
            self.action_gateway.prepare_reload()
            matched = True
        if requested_profile_id in set(
            self.opponent_predictions.runtime_status().get("profileIds") or []
        ):
            self.opponent_predictions.prepare_reload(requested_profile_id)
            matched = True
        if not matched:
            raise ValueError("engine profile is not assigned to a supported output")
        return self.prewarm(requested_profile_id)

    def unload(self, kind: Any, profile_id: Any) -> dict[str, Any]:
        normalized_kind = str(kind or "")
        requested_profile_id = str(profile_id or "")
        if not requested_profile_id:
            raise ValueError("engine profile id is required")
        self.lifecycle.prepare_for_unload()
        if normalized_kind == "decision":
            if (
                str(self.action_gateway.runtime_status().get("profileId") or "")
                != requested_profile_id
            ):
                raise ValueError(
                    "engine profile is not assigned to action recommendation"
                )
            self.action_gateway.unload()
        elif normalized_kind == "opponent-analysis":
            if requested_profile_id not in set(
                self.opponent_predictions.runtime_status().get("profileIds") or []
            ):
                raise ValueError(
                    "engine profile is not assigned to opponent analysis"
                )
            self.opponent_predictions.unload(requested_profile_id)
        else:
            raise ValueError("unknown engine kind")
        return self.lifecycle.build_state()

    @staticmethod
    def describe(payload: dict[str, Any]) -> dict[str, Any]:
        from engine_process_client import EngineProcessClient

        engine_id = str(payload.get("engineId") or "")
        command = payload.get("engineCommand")
        command = (
            [str(part) for part in command]
            if isinstance(command, list)
            else None
        )
        if not command:
            raise ValueError("engine executable is unavailable")
        client = EngineProcessClient(
            "selected",
            command=command,
            cwd=str(payload.get("engineCwd") or "") or None,
            expected_engine_id=engine_id or "",
            expected_engine_version=str(payload.get("engineVersion") or ""),
        )
        try:
            return client.describe()
        finally:
            client.shutdown()

    def decision_response_ms(self) -> list[float]:
        response_times = [0.0, 0.0, 0.0, 0.0]
        analysis_ms = self.action_gateway.average_response_ms()
        if analysis_ms > 0:
            response_times[int(self.state["controlledSeat"]) % 4] = analysis_ms
        return response_times

    def _emit_decision_activity(
        self,
        seat: Any,
        state: Any,
        error: Any = None,
    ) -> None:
        del state, error
        activity = self.action_gateway.get_activity()
        errors = self.action_gateway.get_activity_errors()
        normalized_seat = int(seat) % 4
        effective_state = activity[normalized_seat]
        self.emit(
            {
                "type": "model_activity",
                "model": "decision",
                "seat": normalized_seat,
                "activityState": effective_state,
                "active": effective_state == "running",
                "error": errors[normalized_seat],
                "averageMs": self.decision_response_ms()[normalized_seat],
                "runtime": self.action_gateway.runtime_status(),
                "timestamp": now_iso(),
            }
        )

    def _emit_opponent_analysis_activity(
        self,
        state: Any,
        error: Any = None,
    ) -> None:
        self.emit(
            {
                "type": "model_activity",
                "model": "opponent_analysis",
                "activityState": str(state),
                "active": state == "running",
                "error": error,
                "averageMs": self.opponent_predictions.average_response_ms(),
                "runtime": self.opponent_predictions.runtime_status(),
                "timestamp": now_iso(),
            }
        )
