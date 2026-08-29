"""Coordinate and merge the opponent prediction outputs selected by the host."""
from __future__ import annotations

import copy
import hashlib
import json
import threading
from typing import Any, Callable, Dict, Optional

from opponent_prediction_gateway import OpponentPredictionGateway


SHANTEN_OUTPUT = "opponent-shanten"
DEAL_IN_OUTPUT = "opponent-deal-in-probability"
ANALYSIS_OUTPUT_IDS = (
    SHANTEN_OUTPUT,
    DEAL_IN_OUTPUT,
    "opponent-concealed-tile-count",
    "wall-tile-count",
    "opponent-dora-count",
    "opponent-score",
    "kyoku-outcome",
    "kyoku-score-delta",
    "match-placement",
    "match-score",
)


class OpponentPredictionCoordinator:
    """Use one engine instance per configured profile and merge its output blocks."""

    def __init__(self) -> None:
        self._gateways: list[OpponentPredictionGateway] = []
        self._active: list[OpponentPredictionGateway] = []
        self._activity_callback: Optional[Callable[[str, Optional[str]], None]] = None
        self._callback_lock = threading.Lock()

    def _gateway_at(self, index: int) -> OpponentPredictionGateway:
        while len(self._gateways) <= index:
            gateway = OpponentPredictionGateway(enabled_outputs=[])
            gateway.set_activity_callback(self._child_activity_changed)
            self._gateways.append(gateway)
        return self._gateways[index]

    @staticmethod
    def _profile_identity(profile: Optional[Dict[str, Any]]) -> str:
        if not isinstance(profile, dict):
            return ""
        serializable = {
            key: value
            for key, value in profile.items()
            if key != "engine_client"
        }
        return json.dumps(serializable, sort_keys=True, separators=(",", ":"))

    def configure_profiles(
        self,
        profiles: Optional[Dict[str, Dict[str, Any]]],
        deal_in: Optional[Dict[str, Any]] = None,
    ) -> None:
        if deal_in is not None or (profiles and "profile_id" in profiles):
            profiles = {
                SHANTEN_OUTPUT: profiles,
                DEAL_IN_OUTPUT: deal_in,
            }
        configured = profiles if isinstance(profiles, dict) else {}
        grouped: list[tuple[Dict[str, Any], list[str]]] = []
        group_index: Dict[str, int] = {}
        for output_id in ANALYSIS_OUTPUT_IDS:
            profile = configured.get(output_id)
            if not isinstance(profile, dict) or not profile:
                continue
            identity = self._profile_identity(profile)
            index = group_index.get(identity)
            if index is None:
                group_index[identity] = len(grouped)
                grouped.append((profile, [output_id]))
            else:
                grouped[index][1].append(output_id)

        active: list[OpponentPredictionGateway] = []
        for index, (profile, outputs) in enumerate(grouped):
            gateway = self._gateway_at(index)
            gateway.configure_profile(**profile, enabled_outputs=outputs)
            active.append(gateway)
        for gateway in self._gateways[len(grouped):]:
            gateway.unload()
        self._active = active

    def _gateways_for_profile(
        self,
        profile_id: Optional[str] = None,
    ) -> list[OpponentPredictionGateway]:
        requested = str(profile_id or "")
        if not requested:
            return list(self._active)
        return [
            gateway
            for gateway in self._active
            if str(gateway.runtime_status().get("profileId") or "") == requested
        ]

    def _request_gateways(self) -> list[OpponentPredictionGateway]:
        return [gateway for gateway in self._active if gateway.accepts_requests()]

    @staticmethod
    def _merge_results(results: list[Dict[str, Any]]) -> Dict[str, Any]:
        if not results:
            return {
                "predictions": {"opponents": {}, "ron_wait": {}},
                "ground_truth": {"opponents": {}, "ron_wait": {}},
                "outputs": {},
                "status": "unconfigured",
            }
        merged: Dict[str, Any] = {
            "predictions": {"opponents": {}, "ron_wait": {}},
            "ground_truth": {"opponents": {}, "ron_wait": {}},
            "raw": {},
            "outputs": {},
            "context": copy.deepcopy(results[0].get("context") or {}),
            "status": "ready",
        }
        fingerprints = []
        for result in results:
            for section in ("predictions", "ground_truth"):
                source = result.get(section) if isinstance(result, dict) else None
                if not isinstance(source, dict):
                    continue
                for group in ("opponents", "ron_wait"):
                    values = source.get(group)
                    if isinstance(values, dict):
                        merged[section][group].update(copy.deepcopy(values))
            raw = result.get("raw") if isinstance(result, dict) else None
            if isinstance(raw, dict):
                for player, values in raw.items():
                    if isinstance(values, dict):
                        merged["raw"].setdefault(player, {}).update(copy.deepcopy(values))
            outputs = result.get("outputs") if isinstance(result, dict) else None
            if isinstance(outputs, dict):
                merged["outputs"].update(copy.deepcopy(outputs))
            status = str(result.get("status") or "")
            if status != "ready":
                merged["status"] = status or "prediction_error"
            fingerprint = str(result.get("engineFingerprint") or "")
            if fingerprint:
                fingerprints.append(fingerprint)
        if fingerprints:
            encoded = json.dumps(sorted(fingerprints), separators=(",", ":")).encode()
            merged["engineFingerprint"] = "sha256:" + hashlib.sha256(encoded).hexdigest()
        return merged

    def _combined_callback(
        self,
        gateways: list[OpponentPredictionGateway],
        callback: Optional[Callable[[Dict[str, Any]], None]],
    ) -> list[Callable[[Dict[str, Any]], None]]:
        if not callable(callback) or len(gateways) <= 1:
            return [callback] * len(gateways)
        lock = threading.Lock()
        results: list[Dict[str, Any]] = []

        def collect(result: Dict[str, Any]) -> None:
            ready = None
            with lock:
                results.append(copy.deepcopy(result))
                if len(results) == len(gateways):
                    ready = self._merge_results(results)
            if ready is not None:
                callback(ready)

        return [collect] * len(gateways)

    def request_predict(self, *args, on_complete=None, **kwargs) -> None:
        gateways = self._request_gateways()
        callbacks = self._combined_callback(gateways, on_complete)
        for gateway, callback in zip(gateways, callbacks):
            gateway.request_predict(*args, on_complete=callback, **kwargs)

    def request_background_predict(self, *args, on_complete=None, **kwargs) -> bool:
        gateways = self._request_gateways()
        callbacks = self._combined_callback(gateways, on_complete)
        accepted = False
        for gateway, callback in zip(gateways, callbacks):
            child_accepted = gateway.request_background_predict(
                *args,
                on_complete=callback,
                **kwargs,
            )
            if not child_accepted and callable(callback) and len(gateways) > 1:
                callback(gateway.get_latest())
            accepted = child_accepted or accepted
        return accepted

    def get_latest(self) -> Dict[str, Any]:
        return self._merge_results([
            gateway.get_latest()
            for gateway in self._request_gateways()
        ])

    def prewarm(self, profile_id: Optional[str] = None) -> bool:
        gateways = self._gateways_for_profile(profile_id)
        return bool(gateways) and all(gateway.prewarm() for gateway in gateways)

    def cache_identity(self) -> str:
        identities = [
            gateway.cache_identity()
            for gateway in self._request_gateways()
        ]
        encoded = json.dumps(identities, separators=(",", ":")).encode()
        return "sha256:" + hashlib.sha256(encoded).hexdigest()

    def supported_input_modes(self) -> tuple[str, ...]:
        gateways = self._request_gateways()
        if not gateways:
            return ("public",)
        modes = set(gateways[0].supported_input_modes())
        for gateway in gateways[1:]:
            modes.intersection_update(gateway.supported_input_modes())
        return tuple(mode for mode in ("public", "full-information") if mode in modes)

    def set_activity_callback(
        self,
        callback: Optional[Callable[[str, Optional[str]], None]],
    ) -> None:
        with self._callback_lock:
            self._activity_callback = callback

    def _child_activity_changed(self, _state: str, _error: Optional[str]) -> None:
        with self._callback_lock:
            callback = self._activity_callback
        if callback is not None:
            callback(self.activity_state(), self.activity_error())

    def activity_state(self) -> str:
        states = [gateway.activity_state() for gateway in self._active]
        for state in ("error", "loading", "running"):
            if state in states:
                return state
        return "idle"

    def activity_error(self) -> Optional[str]:
        errors = [gateway.activity_error() for gateway in self._active]
        text = "；".join(dict.fromkeys(error for error in errors if error))
        return text or None

    def average_response_ms(self) -> float:
        return max((gateway.average_response_ms() for gateway in self._active), default=0.0)

    def runtime_status(self) -> Dict[str, Any]:
        statuses = [gateway.runtime_status() for gateway in self._active]
        profile_ids = [str(status.get("profileId") or "") for status in statuses]
        profiles = {
            str(status.get("profileId") or ""): {
                "ready": bool(status.get("ready")),
                "unloaded": bool(status.get("unloaded")),
                "error": str(status.get("error") or ""),
            }
            for status in statuses
            if status.get("profileId")
        }
        return {
            "profileId": "+".join(dict.fromkeys(value for value in profile_ids if value)),
            "profileIds": list(dict.fromkeys(value for value in profile_ids if value)),
            "profiles": profiles,
            "ready": bool(statuses) and all(status.get("ready") for status in statuses),
            "unloaded": not statuses or all(status.get("unloaded") for status in statuses),
        }

    def accepts_requests(self) -> bool:
        return any(gateway.accepts_requests() for gateway in self._active)

    def has_request(self, context: Dict[str, Any]) -> bool:
        return any(gateway.has_request(context) for gateway in self._active)

    def set_latest_context(self, context: Optional[Dict[str, Any]]) -> None:
        for gateway in self._active:
            gateway.set_latest_context(context)

    def prepare_reload(self, profile_id: Optional[str] = None) -> None:
        for gateway in self._gateways_for_profile(profile_id):
            gateway.prepare_reload()

    def unload(self, profile_id: Optional[str] = None) -> None:
        for gateway in self._gateways_for_profile(profile_id):
            gateway.unload()

    def cancel_pending(self) -> None:
        for gateway in self._active:
            gateway.cancel_pending()

    def cancel_background(self) -> None:
        for gateway in self._active:
            gateway.cancel_background()

    def cancel_all(self) -> None:
        for gateway in self._active:
            gateway.cancel_all()

    def shutdown(self) -> None:
        for gateway in self._gateways:
            gateway.shutdown()
