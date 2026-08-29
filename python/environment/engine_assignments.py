"""Resolve protocol output assignments without grouping engines by business kind."""

from __future__ import annotations

from typing import Any


SUPPORTED_OUTPUT_CONTRACTS = (
    {"id": "action-recommendation", "version": 1},
    {"id": "opponent-shanten", "version": 1},
    {"id": "opponent-deal-in-probability", "version": 1},
    {"id": "opponent-concealed-tile-count", "version": 1},
    {"id": "wall-tile-count", "version": 1},
    {"id": "opponent-dora-count", "version": 1},
    {"id": "opponent-score", "version": 1},
    {"id": "kyoku-outcome", "version": 2},
    {"id": "kyoku-score-delta", "version": 1},
    {"id": "match-placement", "version": 1},
    {"id": "match-score", "version": 1},
)
SUPPORTED_OUTPUT_IDS = tuple(contract["id"] for contract in SUPPORTED_OUTPUT_CONTRACTS)
OUTPUT_CONTRACTS_BY_ID = {
    contract["id"]: contract
    for contract in SUPPORTED_OUTPUT_CONTRACTS
}


def resolve_engine_assignments(
    config: Any,
    *,
    loaded_only: bool = False,
) -> list[dict[str, Any]]:
    """Return configured profiles together with the outputs assigned to each one."""
    engines = config.get("engines") if isinstance(config, dict) else None
    if not isinstance(engines, dict):
        return []
    profiles = engines.get("profiles")
    assignments = engines.get("outputAssignments")
    if not isinstance(profiles, list) or not isinstance(assignments, dict):
        return []

    profiles_by_id = {
        str(profile.get("id") or ""): profile
        for profile in profiles
        if isinstance(profile, dict) and str(profile.get("id") or "")
    }
    loaded_profile_ids = engines.get("loadedProfileIds")
    active_ids = (
        {
            str(profile_id)
            for profile_id in loaded_profile_ids
            if str(profile_id)
        }
        if loaded_only and isinstance(loaded_profile_ids, list)
        else None
    )
    outputs_by_profile: dict[str, list[str]] = {}
    for output_id in SUPPORTED_OUTPUT_IDS:
        profile_id = str(assignments.get(output_id) or "")
        if (
            profile_id in profiles_by_id
            and (active_ids is None or profile_id in active_ids)
        ):
            outputs_by_profile.setdefault(profile_id, []).append(output_id)

    return [
        {
            "profileId": profile_id,
            "profile": profile,
            "outputs": outputs_by_profile[profile_id],
        }
        for profile_id, profile in profiles_by_id.items()
        if profile_id in outputs_by_profile
    ]


def profiles_by_output(
    config: Any,
    *,
    loaded_only: bool = False,
) -> dict[str, dict[str, Any]]:
    """Index assigned profiles by output contract ID."""
    return {
        output_id: assignment["profile"]
        for assignment in resolve_engine_assignments(config, loaded_only=loaded_only)
        for output_id in assignment["outputs"]
    }
