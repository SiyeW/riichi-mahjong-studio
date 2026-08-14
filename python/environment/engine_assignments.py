"""Resolve protocol output assignments without grouping engines by business kind."""

from __future__ import annotations

from typing import Any


SUPPORTED_OUTPUT_IDS = (
    "action-recommendation",
    "opponent-shanten",
    "opponent-deal-in-probability",
)


def resolve_engine_assignments(config: Any) -> list[dict[str, Any]]:
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
    outputs_by_profile: dict[str, list[str]] = {}
    for output_id in SUPPORTED_OUTPUT_IDS:
        profile_id = str(assignments.get(output_id) or "")
        if profile_id in profiles_by_id:
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


def profiles_by_output(config: Any) -> dict[str, dict[str, Any]]:
    """Index assigned profiles by output contract ID."""
    return {
        output_id: assignment["profile"]
        for assignment in resolve_engine_assignments(config)
        for output_id in assignment["outputs"]
    }
