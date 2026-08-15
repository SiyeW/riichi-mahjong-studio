"""Shared initialization rules for one configured protocol engine process."""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from typing import Any

from engine_process_client import EngineProcessClient


OutputKey = tuple[str, int]


def _runtime_configuration_key(specification: dict[str, Any]) -> str:
    return json.dumps(
        {
            "profileId": str(specification.get("profile_id") or ""),
            "engineId": str(specification.get("engine_id") or ""),
            "engineVersion": str(specification.get("engine_version") or ""),
            "command": [str(part) for part in specification.get("command") or []],
            "cwd": str(specification.get("cwd") or ""),
            "outputs": specification.get("enabled_outputs") or [],
            "weights": specification.get("weights") or [],
            "device": str(specification.get("device_preference") or "auto"),
            "options": specification.get("options") or {},
        },
        sort_keys=True,
        separators=(",", ":"),
    )


@dataclass(frozen=True)
class EngineInitialization:
    hello: dict[str, Any]
    result: dict[str, Any]
    contracts: dict[OutputKey, dict[str, Any]]
    outputs: dict[OutputKey, dict[str, Any]]
    device: str


def _output_key(value: dict[str, Any]) -> OutputKey:
    return str(value.get("id") or ""), int(value.get("version") or 0)


def initialize_engine_client(
    client: Any,
    *,
    enabled_outputs: list[dict[str, Any]],
    weights: list[dict[str, Any]],
    device_preference: str,
    options: dict[str, Any],
    timeout: float,
) -> EngineInitialization:
    """Validate and initialize the outputs assigned to one engine configuration."""
    configured_outputs = [dict(output) for output in enabled_outputs]
    configured_keys = {_output_key(output) for output in configured_outputs}
    if len(configured_keys) != len(configured_outputs) or any(
        not output_id or version <= 0 for output_id, version in configured_keys
    ):
        raise RuntimeError("enabled engine outputs are invalid or duplicated")

    hello = client.describe()
    contracts = {
        _output_key(output): output
        for output in hello.get("outputContracts") or []
        if isinstance(output, dict)
    }
    requested_outputs = [
        output
        for output in configured_outputs
        if _output_key(output) in contracts
    ]
    requested_keys = {_output_key(output) for output in requested_outputs}
    if not requested_outputs:
        raise RuntimeError("engine does not provide any compatible enabled outputs")

    slots = {
        str(slot.get("id") or ""): slot
        for slot in hello.get("weightSlots") or []
        if isinstance(slot, dict)
    }
    all_configured_by_slot = {
        str(weight.get("slotId") or ""): weight
        for weight in weights
    }
    if len(all_configured_by_slot) != len(weights) or "" in all_configured_by_slot:
        raise RuntimeError("configured engine weights are invalid or duplicated")
    required_slot_ids = {
        slot_id
        for slot_id, slot in slots.items()
        if any(
            _output_key(item) in requested_keys
            for item in slot.get("requiredForOutputs") or []
            if isinstance(item, dict)
        )
    }
    configured_by_slot = {
        slot_id: weight
        for slot_id, weight in all_configured_by_slot.items()
        if slot_id in required_slot_ids
    }
    for slot_id, weight in configured_by_slot.items():
        slot = slots.get(slot_id)
        formats = slot.get("formats") if isinstance(slot, dict) else None
        if not isinstance(formats, list) or not any(
            isinstance(item, dict) and item.get("id") == weight.get("format")
            for item in formats
        ):
            raise RuntimeError(f"engine does not accept the configured {slot_id} weight")
    for slot_id in required_slot_ids:
        if slot_id not in configured_by_slot:
            raise RuntimeError(f"engine requires the {slot_id} weight")

    device_types = [
        str(item.get("type") or "")
        for item in hello.get("devices") or []
        if isinstance(item, dict) and item.get("type")
    ]
    selected_device = (
        device_preference
        if device_preference in device_types
        else (device_types[0] if device_types else "")
    )
    if not selected_device:
        raise RuntimeError("engine did not declare a usable device")

    result = client.initialize(
        requested_outputs,
        [dict(configured_by_slot[slot_id]) for slot_id in slots if slot_id in configured_by_slot],
        device=selected_device,
        options=dict(options),
        timeout=timeout,
    )
    initialized_outputs = result.get("outputs")
    if not isinstance(initialized_outputs, list):
        raise RuntimeError("engine initialization returned unexpected outputs")
    outputs = {
        _output_key(output): output
        for output in initialized_outputs
        if isinstance(output, dict)
    }
    if set(outputs) != requested_keys or len(outputs) != len(initialized_outputs):
        raise RuntimeError("engine initialization returned unexpected outputs")

    actual_device = str((result.get("device") or {}).get("type") or selected_device)
    return EngineInitialization(
        hello=dict(hello),
        result=dict(result),
        contracts=contracts,
        outputs=outputs,
        device=actual_device,
    )


class EngineProfileRuntime:
    """Own the single process and initialization for one configured engine profile."""

    def __init__(
        self,
        *,
        profile_id: str,
        engine_id: str,
        engine_version: str,
        command: list[str],
        cwd: str | None,
        enabled_outputs: list[dict[str, Any]],
        weights: list[dict[str, Any]],
        device_preference: str,
        options: dict[str, Any],
    ) -> None:
        self.profile_id = str(profile_id)
        self._enabled_outputs = [dict(output) for output in enabled_outputs]
        self._enabled_keys = {_output_key(output) for output in self._enabled_outputs}
        self._weights = [dict(weight) for weight in weights]
        self._device_preference = str(device_preference or "auto")
        self._options = dict(options)
        self._initialization: EngineInitialization | None = None
        self._initialization_lock = threading.Lock()
        self._listeners: list[Any] = []
        self._listeners_lock = threading.Lock()
        self._client = EngineProcessClient(
            f"profile:{self.profile_id}",
            self._notify,
            command=command,
            cwd=cwd,
            expected_engine_id=engine_id,
            expected_engine_version=engine_version,
        )
        self.configuration_key = _runtime_configuration_key({
            "profile_id": self.profile_id,
            "engine_id": engine_id,
            "engine_version": engine_version,
            "command": command,
            "cwd": cwd,
            "enabled_outputs": self._enabled_outputs,
            "weights": self._weights,
            "device_preference": self._device_preference,
            "options": self._options,
        })

    def add_notification_listener(self, listener: Any) -> None:
        if not callable(listener):
            return
        with self._listeners_lock:
            if listener not in self._listeners:
                self._listeners.append(listener)

    def _notify(self, method: str, params: dict[str, Any]) -> None:
        with self._listeners_lock:
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener(method, params)
            except Exception:
                pass

    def describe(self) -> dict[str, Any]:
        return self._client.describe()

    def initialize(
        self,
        enabled_outputs: list[dict[str, Any]],
        _weights: list[dict[str, Any]],
        *,
        device: str = "cpu",
        options: dict[str, Any] | None = None,
        timeout: float = 180,
    ) -> dict[str, Any]:
        del device, options
        requested_outputs = [dict(output) for output in enabled_outputs]
        requested_keys = {_output_key(output) for output in requested_outputs}
        if len(requested_keys) != len(requested_outputs) or not requested_keys.issubset(
            self._enabled_keys
        ):
            raise RuntimeError("gateway requested outputs outside its engine profile")
        with self._initialization_lock:
            if self._initialization is None:
                self._initialization = initialize_engine_client(
                    self._client,
                    enabled_outputs=self._enabled_outputs,
                    weights=self._weights,
                    device_preference=self._device_preference,
                    options=self._options,
                    timeout=timeout,
                )
            initialized = self._initialization
        result = dict(initialized.result)
        unavailable = [
            _output_key(output)
            for output in requested_outputs
            if _output_key(output) not in initialized.outputs
        ]
        if unavailable:
            output_id, version = unavailable[0]
            raise RuntimeError(f"engine does not provide {output_id} version {version}")
        result["outputs"] = [dict(initialized.outputs[_output_key(output)]) for output in requested_outputs]
        return result

    def request(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return self._client.request(*args, **kwargs)

    def restart(self) -> None:
        with self._initialization_lock:
            self._initialization = None
        self._client.restart()

    def shutdown(self) -> None:
        with self._initialization_lock:
            self._initialization = None
        self._client.shutdown()


class EngineRuntimeRegistry:
    """Reuse one runtime for every output assigned to the same profile."""

    def __init__(self) -> None:
        self._runtimes: dict[str, EngineProfileRuntime] = {}

    def reconcile(self, specifications: list[dict[str, Any]]) -> None:
        next_runtimes: dict[str, EngineProfileRuntime] = {}
        for specification in specifications:
            profile_id = str(specification.get("profile_id") or "")
            configuration_key = _runtime_configuration_key(specification)
            existing = self._runtimes.get(profile_id)
            if existing is not None and existing.configuration_key == configuration_key:
                next_runtimes[profile_id] = existing
            else:
                if existing is not None:
                    existing.shutdown()
                next_runtimes[profile_id] = EngineProfileRuntime(**specification)
        for profile_id, runtime in self._runtimes.items():
            if profile_id not in next_runtimes:
                runtime.shutdown()
        self._runtimes = next_runtimes

    def get(self, profile_id: str) -> EngineProfileRuntime | None:
        return self._runtimes.get(str(profile_id or ""))

    def shutdown(self) -> None:
        for runtime in self._runtimes.values():
            runtime.shutdown()
        self._runtimes.clear()
