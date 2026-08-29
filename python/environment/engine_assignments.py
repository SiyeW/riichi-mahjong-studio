"""Resolve protocol output assignments without grouping engines by business kind."""

from __future__ import annotations

from typing import Any


SUPPORTED_OUTPUT_CONTRACTS = (
    {"id": "action-recommendation"},
    {"id": "opponent-shanten"},
    {"id": "opponent-deal-in-probability"},
    {"id": "opponent-concealed-tile-count"},
    {"id": "wall-tile-count"},
    {"id": "opponent-dora-count"},
    {"id": "opponent-score"},
    {"id": "kyoku-outcome"},
    {"id": "kyoku-score-delta"},
    {"id": "match-placement"},
    {"id": "match-score"},
)
SUPPORTED_OUTPUT_IDS = tuple(contract["id"] for contract in SUPPORTED_OUTPUT_CONTRACTS)
OUTPUT_CONTRACTS_BY_ID = {
    contract["id"]: contract
    for contract in SUPPORTED_OUTPUT_CONTRACTS
}

# Compatibility with protocol 2.0 and 2.1, whose output references carried a
# separate version. Current protocol output references are identified by ID.
LEGACY_OUTPUT_VERSIONS = {output_id: 1 for output_id in SUPPORTED_OUTPUT_IDS}


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
