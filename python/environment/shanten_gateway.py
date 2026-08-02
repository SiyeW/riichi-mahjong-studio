"""Generic process gateway for an external opponent-analysis engine."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable, Dict, Optional

import numpy as np

from engine_process_client import EngineProcessClient  # noqa: E402

TILE34_NAMES = [
    *(f"{number}m" for number in range(1, 10)),
    *(f"{number}p" for number in range(1, 10)),
    *(f"{number}s" for number in range(1, 10)),
    "E", "S", "W", "N", "P", "F", "C",
]

_LATEST_SHANTEN_MJAI: Dict[str, Any] = {}
_PROBABILITY_TOLERANCE = 1e-4
_ENGINE_POSTPROCESSOR_VERSION = "opponent-analysis-v3"


def _canonical_history_digest(events: list[dict]) -> str:
    payload = json.dumps(
        events,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def get_latest_shanten_mjai() -> Dict[str, Any]:
    return dict(_LATEST_SHANTEN_MJAI)


class ShantenPredictorGateway:
    """Background worker for opponent shanten prediction."""

    def __init__(self, model_path: Optional[str] = None):
        self._model_path = Path(model_path) if model_path else Path("__unconfigured__")
        self._process_client = EngineProcessClient(
            "opponent-analysis",
            self._on_engine_notification,
            expected_engine_id="",
        )
        self._profile_id = ""
        self._engine_id = ""
        self._engine_version = ""
        self._model_id = ""
        self._model_format = ""
        self._engine_options: Dict[str, Any] = {}
        self._supported_input_modes = ("public",)
        self._model_hash_cache: Optional[tuple[str, int, int, str]] = None
        self._model_signature = self._read_model_signature()
        self._expected_sha256 = self._read_expected_sha256()
        self._engine_fingerprint = ""
        self._device_preference = "auto"
        self._model_ready = False
        self._initialization_lock = threading.Lock()
        self._lock = threading.Lock()
        self._activity_lock = threading.Lock()
        self._activity_callback: Optional[Callable[[str, Optional[str]], None]] = None
        self._activity_state = "idle"
        self._activity_error: Optional[str] = None
        self._error_latched = False
        self._unloaded = False
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
    ) -> None:
        if method == "task.status":
            state = str(params.get("state") or "")
            if state in ("queued", "running"):
                self._set_activity("running")
            elif state == "error":
                self._set_activity("error", str(params.get("message") or "引擎推理失败"))
            elif state in ("completed", "canceled"):
                self._set_activity("idle")
            return
        if method != "engine.status":
            return
        state = str(params.get("state") or "")
        if state in ("starting", "loading", "reloading"):
            self._set_activity("loading")
        elif state == "error":
            error = params.get("error") or {}
            self._set_activity(
                "error",
                str(error.get("message") or params.get("message") or "引擎错误"),
            )
        elif state in ("ready", "stopping", "stopped"):
            self._set_activity("idle")

    def _read_model_signature(self) -> str:
        try:
            stat = self._model_path.stat()
            return f"{self._model_path.name}:{stat.st_size}:{stat.st_mtime_ns}"
        except OSError:
            return f"{self._model_path.name}:missing"

    def _read_expected_sha256(self) -> str:
        metadata_path = self._model_path.with_name("model.json")
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if metadata.get("file") == self._model_path.name:
                return str(metadata.get("sha256") or "").lower()
        except (OSError, ValueError):
            pass
        return ""

    def _model_sha256(self) -> str:
        if self._expected_sha256:
            return self._expected_sha256
        try:
            path = self._model_path.resolve()
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

    def cache_identity(self) -> str:
        if self._engine_fingerprint:
            return self._engine_fingerprint
        source = {
            "engineId": self._engine_id,
            "version": self._engine_version,
            "protocolMajor": 1,
            "modelSha256": self._model_sha256(),
            "options": self._engine_options,
            "outputSchema": "opponent-analysis-v1",
            "resultSemanticsVersion": _ENGINE_POSTPROCESSOR_VERSION,
        }
        encoded = json.dumps(
            source,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return "sha256:" + hashlib.sha256(encoded).hexdigest()

    def model_signature(self) -> str:
        return self._model_signature

    @property
    def device_str(self) -> str:
        return "engine"

    def supported_input_modes(self) -> tuple[str, ...]:
        return self._supported_input_modes

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
    ) -> None:
        next_model_path = Path(model_path) if model_path else Path("__unconfigured__")
        if not next_model_path.is_absolute():
            next_model_path = Path.cwd() / next_model_path
        next_command = [str(part) for part in (engine_command or [])]
        next_modes = tuple(
            mode
            for mode in (input_modes or ["public"])
            if mode in ("public", "full-information")
        ) or ("public",)
        next_identity = (
            str(profile_id),
            str(engine_id),
            str(engine_version or "1.0.0"),
            str(model_id),
            str(model_format),
            str(next_model_path.resolve()),
            str(expected_sha256 or "").lower(),
            tuple(next_command),
            str(engine_cwd or ""),
            json.dumps(engine_options or {}, sort_keys=True, separators=(",", ":")),
            next_modes,
        )
        current_identity = (
            self._profile_id,
            self._engine_id,
            self._engine_version,
            self._model_id,
            self._model_format,
            str(self._model_path.resolve()),
            self._expected_sha256,
            tuple(getattr(self, "_engine_command", []) or []),
            getattr(self, "_engine_cwd", "") or "",
            json.dumps(self._engine_options, sort_keys=True, separators=(",", ":")),
            self._supported_input_modes,
        )
        if next_identity == current_identity:
            return
        self.cancel_all()
        self._process_client.shutdown()
        (
            self._profile_id,
            self._engine_id,
            self._engine_version,
            self._model_id,
            self._model_format,
            model_path_value,
            self._expected_sha256,
            command_parts,
            engine_cwd_value,
            options_json,
            self._supported_input_modes,
        ) = next_identity
        self._model_path = Path(model_path_value)
        self._model_hash_cache = None
        self._engine_command = list(command_parts)
        self._engine_cwd = engine_cwd_value
        self._engine_options = json.loads(options_json)
        configured_device = str(self._engine_options.get("device") or "auto")
        if configured_device not in ("auto", "cpu", "cuda"):
            configured_device = "auto"
        self._device_preference = configured_device
        self._process_client = EngineProcessClient(
            "opponent-analysis",
            self._on_engine_notification,
            command=self._engine_command or None,
            cwd=self._engine_cwd or None,
            expected_engine_id=self._engine_id,
        )
        self._model_signature = self._read_model_signature()
        self._engine_fingerprint = ""
        self._model_ready = False
        with self._activity_lock:
            self._error_latched = False
            self._unloaded = False
        self._set_activity("idle")

    def set_force_device(self, force_device: Optional[str]) -> None:
        """Forward a legacy device preference to engines that still support it."""
        configured_device = str(force_device or "auto")
        if configured_device not in ("auto", "cpu", "cuda"):
            configured_device = "auto"
        if configured_device == self._device_preference:
            return
        self.cancel_all()
        self._device_preference = configured_device
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
            "profileId": self._profile_id,
            "ready": bool(self._model_ready),
            "unloaded": self._unloaded,
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
    ) -> None:
        callback = None
        with self._activity_lock:
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
        self.cancel_all()
        self._model_ready = False
        self._engine_fingerprint = ""
        self._model_hash_cache = None
        with self._activity_lock:
            self._response_times.clear()
            self._last_response_ms = 0.0
            self._error_latched = False
            self._unloaded = False
        self._process_client.restart()
        self._set_activity("idle")

    def unload(self) -> None:
        self.cancel_all()
        self._process_client.shutdown()
        self._model_ready = False
        self._engine_fingerprint = ""
        self._model_hash_cache = None
        with self._activity_lock:
            self._response_times.clear()
            self._last_response_ms = 0.0
            self._error_latched = False
            self._unloaded = True
        self._set_activity("idle")

    def _has_live_context(self) -> bool:
        with self._lock:
            return self._latest_context is not None

    def prewarm(self) -> bool:
        """Load weights and complete one device forward pass without game input."""
        with self._activity_lock:
            if self._error_latched or self._unloaded:
                return False
        with self._initialization_lock:
            return self._prewarm_locked()

    def _prewarm_locked(self) -> bool:
        if self._model_ready:
            return True
        self._set_activity("loading")
        try:
            result = self._process_client.initialize(
                self._profile_id,
                "opponent-analysis",
                str(self._model_path),
                model_id=self._model_id,
                model_format=self._model_format,
                expected_sha256=self._expected_sha256,
                device=self._device_preference,
                options=self._engine_options,
                timeout=180,
            )
            if str(result.get("engineId") or "") != self._engine_id:
                raise RuntimeError("opponent-analysis engine initialize identity mismatch")
            if str(result.get("outputSchema") or "") != "opponent-analysis-v1":
                raise RuntimeError(
                    "opponent-analysis engine must initialize with "
                    "outputSchema=opponent-analysis-v1"
                )
            self._model_ready = result.get("state") == "ready"
            self._engine_fingerprint = str(result.get("fingerprint") or "")
            if not self._engine_fingerprint:
                raise RuntimeError("opponent-analysis engine returned no fingerprint")
            capabilities = result.get("capabilities") or {}
            runtime_modes = capabilities.get("opponentInputModes")
            if isinstance(runtime_modes, list):
                self._supported_input_modes = tuple(
                    mode
                    for mode in self._supported_input_modes
                    if mode in runtime_modes
                ) or ("public",)
            if self._model_ready:
                with self._lock:
                    self._latest["status"] = "loaded"
            return self._model_ready
        except Exception as exc:
            print(f"[SHANTEN] Prewarm failed: {exc}", flush=True)
            self._set_activity("error", self._format_error("模型预热失败", exc))
            return False
        finally:
            with self._lock:
                has_work = self._pending is not None or self._active_context is not None
            if not has_work and self.activity_state() != "error":
                self._set_activity("idle")

    @staticmethod
    def _validate_probability(value: Any, field: str) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise RuntimeError(f"{field} must be a number")
        result = float(value)
        if not math.isfinite(result):
            raise RuntimeError(f"{field} must be a finite probability")
        if result < -_PROBABILITY_TOLERANCE or result > 1.0 + _PROBABILITY_TOLERANCE:
            raise RuntimeError(f"{field} must be between zero and one")
        # Engines commonly reconstruct a probability from float32 components.
        # Absorb harmless boundary drift while still rejecting genuine bad data.
        return min(1.0, max(0.0, result))

    def _validate_protocol_prediction(
        self,
        result: Dict[str, Any],
        *,
        session_id: str,
        position_id: str,
        history_digest: str,
        controlled_seat: int,
        input_mode: str,
    ) -> list[Dict[str, Any]]:
        echoes = {
            "sessionId": session_id,
            "positionId": position_id,
            "historyDigest": history_digest,
            "inputMode": input_mode,
            "engineFingerprint": self._engine_fingerprint,
        }
        for field, expected in echoes.items():
            if str(result.get(field) or "") != expected:
                raise RuntimeError(f"opponent-analysis response {field} mismatch")

        players = result.get("players")
        if not isinstance(players, list) or len(players) != 3:
            raise RuntimeError("opponent-analysis response must contain exactly three players")
        expected_seats = {seat for seat in range(4) if seat != controlled_seat}
        actual_seats: set[int] = set()
        validated = []
        for player in players:
            if not isinstance(player, dict):
                raise RuntimeError("opponent-analysis player must be an object")
            seat = int(player.get("seat", -1))
            if seat not in expected_seats or seat in actual_seats:
                raise RuntimeError("opponent-analysis player seats are invalid")
            actual_seats.add(seat)

            shanten = player.get("shanten")
            if not isinstance(shanten, list) or len(shanten) != 7:
                raise RuntimeError("opponent-analysis shanten must contain values 0 through 6")
            by_value: Dict[int, float] = {}
            for entry in shanten:
                if not isinstance(entry, dict):
                    raise RuntimeError("opponent-analysis shanten entry must be an object")
                value = int(entry.get("value", -1))
                if value not in range(7) or value in by_value:
                    raise RuntimeError("opponent-analysis shanten values are invalid")
                by_value[value] = self._validate_probability(
                    entry.get("probability"),
                    f"players[{seat}].shanten[{value}]",
                )
            if set(by_value) != set(range(7)):
                raise RuntimeError("opponent-analysis shanten values are incomplete")
            if abs(sum(by_value.values()) - 1.0) > _PROBABILITY_TOLERANCE:
                raise RuntimeError("opponent-analysis shanten probabilities do not sum to one")

            waits = player.get("ronWaits")
            if not isinstance(waits, dict) or set(waits) != set(TILE34_NAMES):
                raise RuntimeError("opponent-analysis ronWaits must cover all 34 tiles")
            validated_waits = {
                tile: self._validate_probability(
                    waits[tile],
                    f"players[{seat}].ronWaits.{tile}",
                )
                for tile in TILE34_NAMES
            }
            validated.append(
                {
                    "seat": seat,
                    "shanten": [by_value[value] for value in range(7)],
                    "furiten": self._validate_probability(
                        player.get("furitenOrNoYaku"),
                        f"players[{seat}].furitenOrNoYaku",
                    ),
                    "ronWaits": validated_waits,
                }
            )
        if actual_seats != expected_seats:
            raise RuntimeError("opponent-analysis response is missing a player")
        return validated

    def _ground_truth(
        self,
        events: list[dict],
        controlled_seat: int,
        *,
        event_prefix_hashes: Optional[list[int]],
        event_hash: Optional[int],
    ) -> tuple[Dict[str, list[float]], Dict[str, list[float]]]:
        del events, controlled_seat, event_prefix_hashes, event_hash
        # Ground truth is deliberately host-independent in the public build.
        # A future rules-only implementation may populate this without model code.
        return {}, {}

    def _protocol_result_to_host(
        self,
        players: list[Dict[str, Any]],
        *,
        events: list[dict],
        target_events: Optional[list[dict]],
        controlled_seat: int,
        context: Dict[str, Any],
        target_prefix_hashes: Optional[list[int]],
        target_event_hash: Optional[int],
    ) -> Dict[str, Any]:
        by_seat = {int(player["seat"]): player for player in players}
        opponents: Dict[str, list[float]] = {}
        waits: Dict[str, list[float]] = {}
        raw: Dict[str, Any] = {}
        for offset, label in enumerate(("shimocha", "toimen", "kamicha"), start=1):
            seat = (controlled_seat + offset) % 4
            player = by_seat[seat]
            shanten = list(player["shanten"])
            furiten = float(player["furiten"])
            raw_waits = [float(player["ronWaits"][tile]) for tile in TILE34_NAMES]
            display = np.zeros(8, dtype=np.float32)
            display[0] = shanten[0] * (1.0 - furiten)
            display[1:7] = shanten[1:7]
            display[7] = shanten[0] * furiten
            opponents[label] = [float(value) for value in display]
            waits[label] = raw_waits
            raw[label] = {
                "seat": seat,
                "shanten_probs": list(player["shanten"]),
                "furiten_prob": furiten,
                "ron_wait": raw_waits,
            }

        ground_truth_opponents: Dict[str, list[float]] = {}
        ground_truth_waits: Dict[str, list[float]] = {}
        if target_events is not None:
            ground_truth_opponents, ground_truth_waits = self._ground_truth(
                target_events,
                controlled_seat,
                event_prefix_hashes=target_prefix_hashes,
                event_hash=target_event_hash,
            )
        return {
            "predictions": {"opponents": opponents, "ron_wait": waits},
            "ground_truth": {
                "opponents": ground_truth_opponents,
                "ron_wait": ground_truth_waits,
            },
            "raw": raw,
            "context": copy.deepcopy(context),
            "status": "ready",
            "engineFingerprint": self._engine_fingerprint,
        }

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
                global _LATEST_SHANTEN_MJAI
                _LATEST_SHANTEN_MJAI = {
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
                position_id = str(context.get("nodeId") or "")
                history_digest = _canonical_history_digest(events)
                worker_result = self._process_client.request(
                    "opponent.predict",
                    {
                        "sessionId": session_id,
                        "positionId": position_id,
                        "historyDigest": history_digest,
                        "controlledSeat": c,
                        "inputMode": input_mode,
                        "priority": "background" if is_background else "interactive",
                        "events": events,
                    },
                    timeout=180 if initializing else 30,
                )
                players = self._validate_protocol_prediction(
                    worker_result,
                    session_id=session_id,
                    position_id=position_id,
                    history_digest=history_digest,
                    controlled_seat=c,
                    input_mode=input_mode,
                )
                result = self._protocol_result_to_host(
                    players,
                    events=events,
                    target_events=target_events,
                    controlled_seat=c,
                    context=context,
                    target_prefix_hashes=pending.get("target_mjai_prefix_hashes"),
                    target_event_hash=pending.get("target_mjai_events_hash"),
                )
                self._model_ready = True
                if not is_background and self._is_superseded(context):
                    continue
                if not is_background:
                    with self._lock:
                        self._latest = result
                worker_response_ms = worker_result.get("responseMs")
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
        self._running = False
        self._pending_event.set()
        self._process_client.shutdown()
