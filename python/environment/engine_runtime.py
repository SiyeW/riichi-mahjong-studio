"""Shared initialization rules for one configured protocol engine process."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


OutputKey = tuple[str, int]


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
    requested_outputs = [dict(output) for output in enabled_outputs]
    requested_keys = {_output_key(output) for output in requested_outputs}
    if len(requested_keys) != len(requested_outputs) or any(
        not output_id or version <= 0 for output_id, version in requested_keys
    ):
        raise RuntimeError("enabled engine outputs are invalid or duplicated")

    hello = client.describe()
    contracts = {
        _output_key(output): output
        for output in hello.get("outputContracts") or []
        if isinstance(output, dict)
    }
    for output_id, version in requested_keys:
        if (output_id, version) not in contracts:
            raise RuntimeError(f"engine does not provide {output_id} version {version}")

    slots = {
        str(slot.get("id") or ""): slot
        for slot in hello.get("weightSlots") or []
        if isinstance(slot, dict)
    }
    configured_by_slot = {
        str(weight.get("slotId") or ""): weight
        for weight in weights
    }
    if len(configured_by_slot) != len(weights) or "" in configured_by_slot:
        raise RuntimeError("configured engine weights are invalid or duplicated")
    for slot_id, weight in configured_by_slot.items():
        slot = slots.get(slot_id)
        formats = slot.get("formats") if isinstance(slot, dict) else None
        if not isinstance(formats, list) or not any(
            isinstance(item, dict) and item.get("id") == weight.get("format")
            for item in formats
        ):
            raise RuntimeError(f"engine does not accept the configured {slot_id} weight")
    for slot_id, slot in slots.items():
        required = slot.get("requiredForOutputs") or []
        if any(
            _output_key(item) in requested_keys
            for item in required
            if isinstance(item, dict)
        ) and slot_id not in configured_by_slot:
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
        [dict(weight) for weight in weights],
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
