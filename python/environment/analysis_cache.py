import copy
import hashlib
import json


ANALYSIS_SOURCES_FIELD = "analysisSources"
OPPONENT_ANALYSIS_CACHE_FIELD = "opponentAnalysisCache"

_ANALYSIS_SOURCE_SCHEMA_VERSION = 2
_DECISION_CACHE_VERSION = 3
_OPPONENT_ANALYSIS_CACHE_VERSION = 4
_OPPONENT_ANALYSIS_SECTIONS = ("predictions", "ground_truth")
_OPPONENT_ANALYSIS_GROUPS = ("opponents", "ron_wait")


def build_analysis_source(
    kind,
    engine_identity,
    host_postprocessor_version,
    output_contract,
    *,
    display_name=None,
):
    identity = {
        "schemaVersion": _ANALYSIS_SOURCE_SCHEMA_VERSION,
        "kind": str(kind),
        "engineIdentity": str(engine_identity or "legacy-unknown"),
        "outputContract": str(output_contract),
    }
    if host_postprocessor_version:
        identity["hostPostprocessorVersion"] = str(host_postprocessor_version)
    encoded = json.dumps(
        identity,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    fingerprint = f"sha256:{hashlib.sha256(encoded).hexdigest()}"
    prefix = "m" if kind == "decision" else "o"
    return {
        **identity,
        "id": f"{prefix}-{fingerprint[7:23]}",
        "cacheFingerprint": fingerprint,
        "displayName": str(display_name or kind),
    }


def register_analysis_source(game, source, result=None):
    if not isinstance(game, dict) or not isinstance(source, dict):
        return
    source_id = str(source.get("id") or "")
    if not source_id:
        return
    stored = copy.deepcopy(source)
    if isinstance(result, dict) and result.get("engineFingerprint"):
        stored["engineFingerprint"] = str(result["engineFingerprint"])
    sources = game.setdefault(ANALYSIS_SOURCES_FIELD, {})
    existing = sources.get(source_id)
    if isinstance(existing, dict):
        stored = {**existing, **stored}
    sources[source_id] = stored


def decision_cache_key(seat, phase, source):
    return f"m{_DECISION_CACHE_VERSION}::{int(seat)}::{phase}::{source['id']}"


def opponent_analysis_cache_key(seat, input_mode, source):
    return f"o{_OPPONENT_ANALYSIS_CACHE_VERSION}::{int(seat)}::{input_mode}::{source['id']}"


def cache_key_context(cache_key):
    parts = str(cache_key or "").split("::")
    if len(parts) != 4:
        return None
    version, seat, mode, source_id = parts
    if version not in (
        f"m{_DECISION_CACHE_VERSION}",
        f"o{_OPPONENT_ANALYSIS_CACHE_VERSION}",
    ):
        return None
    try:
        resolved_seat = int(seat)
    except (TypeError, ValueError):
        return None
    return {
        "kind": "decision" if version.startswith("m") else "opponent",
        "seat": resolved_seat,
        "mode": mode,
        "sourceId": source_id,
    }


def prune_stale_cache_entries(cache, current_key):
    current = cache_key_context(current_key)
    if not isinstance(cache, dict) or current is None:
        return
    for cache_key in list(cache):
        candidate = cache_key_context(cache_key)
        if (
            candidate is not None
            and candidate["kind"] == current["kind"]
            and candidate["seat"] == current["seat"]
            and candidate["mode"] == current["mode"]
            and cache_key != current_key
        ):
            cache.pop(cache_key, None)


def find_stale_cache_entry(game, node, current_key, cache_field):
    current = cache_key_context(current_key)
    cache = node.get(cache_field) if isinstance(node, dict) else None
    if current is None or not isinstance(cache, dict):
        return None
    for cache_key, result in reversed(list(cache.items())):
        candidate = cache_key_context(cache_key)
        if (
            cache_key != current_key
            and candidate is not None
            and candidate["kind"] == current["kind"]
            and candidate["seat"] == current["seat"]
            and candidate["mode"] == current["mode"]
            and isinstance(result, dict)
            and not result.get("error")
        ):
            payload = copy.deepcopy(result)
            payload["cacheStatus"] = "stale"
            payload["cacheSource"] = copy.deepcopy(
                (game.get(ANALYSIS_SOURCES_FIELD) or {}).get(candidate["sourceId"])
            )
            return payload
    return None


def migrate_analysis_cache_storage(game):
    if not isinstance(game, dict):
        return
    game.setdefault(ANALYSIS_SOURCES_FIELD, {})
    for node in game.get("nodes", {}).values():
        decision_cache = node.setdefault("analysisCache", {})
        if isinstance(decision_cache, dict):
            for cache_key in list(decision_cache):
                if cache_key_context(cache_key) is None:
                    decision_cache.pop(cache_key, None)

        opponent_cache = node.get(OPPONENT_ANALYSIS_CACHE_FIELD)
        if isinstance(opponent_cache, dict):
            for cache_key in list(opponent_cache):
                if cache_key_context(cache_key) is None:
                    opponent_cache.pop(cache_key, None)


def quantize_probability(value):
    try:
        probability = float(value)
    except (TypeError, ValueError):
        probability = 0.0
    probability = max(0.0, min(1.0, probability))
    if probability == 0.0:
        return 0.0
    if probability < 0.0001:
        return 0.00001
    return round(probability * 10000.0) / 10000.0


def compact_opponent_analysis(result):
    compact = {
        "status": "ready",
        "precisionPercent": 0.01,
    }
    for section_name in _OPPONENT_ANALYSIS_SECTIONS:
        section = result.get(section_name) if isinstance(result, dict) else None
        compact_section = {}
        for group_name in _OPPONENT_ANALYSIS_GROUPS:
            group = section.get(group_name) if isinstance(section, dict) else None
            compact_section[group_name] = {
                str(label): [quantize_probability(value) for value in values]
                for label, values in (group.items() if isinstance(group, dict) else [])
                if isinstance(values, list)
            }
        compact[section_name] = compact_section
    return compact


def same_analysis_context(left, right):
    if not isinstance(left, dict) or not isinstance(right, dict):
        return False
    return all(
        left.get(key) == right.get(key)
        for key in ("gameId", "nodeId", "seat", "cacheKey", "cacheEpoch")
    )


def attach_analysis_context(result, context):
    payload = copy.deepcopy(result)
    payload["context"] = copy.deepcopy(context)
    return payload
