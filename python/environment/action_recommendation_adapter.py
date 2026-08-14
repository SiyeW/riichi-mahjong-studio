"""Convert protocol action recommendations into host analysis and play data."""

from __future__ import annotations

import copy
import math
import pathlib
import sys
import threading
from typing import Any, Dict, List, Optional

from mjai_stream import build_mjai_stream


def get_project_root() -> pathlib.Path:
    if getattr(sys, "frozen", False):
        return pathlib.Path(sys._MEIPASS)
    return pathlib.Path(__file__).resolve().parents[2]


PROJECT_ROOT = get_project_root()


def resolve_engine_weight_path(path_value: str) -> str:
    path = pathlib.Path(path_value)
    return str(path if path.is_absolute() else PROJECT_ROOT / path)


_LATEST_DEBUG: Dict[str, Any] = {}
_DEBUG_LOCK = threading.Lock()


def _store_debug(
    *,
    caller: str,
    seat: int,
    events: List[Dict[str, Any]],
    result: Dict[str, Any],
) -> None:
    global _LATEST_DEBUG
    with _DEBUG_LOCK:
        _LATEST_DEBUG = {
            "caller": caller,
            "seat": int(seat),
            "eventCount": len(events),
            "events": copy.deepcopy(events),
            "result": copy.deepcopy(result),
        }


def get_latest_action_recommendation_debug() -> Dict[str, Any]:
    with _DEBUG_LOCK:
        return copy.deepcopy(_LATEST_DEBUG)


_ACCUMULATED_THINKING_TIME_S = 0.0
_THINKING_TIME_MIN_S = 0.5
_THINKING_TIME_MAX_S = 1.0
_THINKING_TIME_LOCK = threading.Lock()


def _accumulate_thinking_time(thinking_time_s: float) -> None:
    global _ACCUMULATED_THINKING_TIME_S
    with _THINKING_TIME_LOCK:
        _ACCUMULATED_THINKING_TIME_S = max(
            _ACCUMULATED_THINKING_TIME_S,
            float(thinking_time_s),
        )


def get_and_reset_ai_thinking_time_s() -> float:
    global _ACCUMULATED_THINKING_TIME_S
    with _THINKING_TIME_LOCK:
        result = _ACCUMULATED_THINKING_TIME_S
        _ACCUMULATED_THINKING_TIME_S = 0.0
    return result


def set_thinking_time_bounds(min_s: float, max_s: float) -> None:
    global _THINKING_TIME_MIN_S, _THINKING_TIME_MAX_S
    minimum = max(0.0, float(min_s))
    with _THINKING_TIME_LOCK:
        _THINKING_TIME_MIN_S = minimum
        _THINKING_TIME_MAX_S = max(minimum, float(max_s))


def _compute_thinking_time(values: List[float]) -> float:
    finite = sorted(
        (
            float(value)
            for value in values
            if isinstance(value, (int, float))
            and not isinstance(value, bool)
            and math.isfinite(float(value))
        ),
        reverse=True,
    )
    with _THINKING_TIME_LOCK:
        minimum = _THINKING_TIME_MIN_S
        maximum = _THINKING_TIME_MAX_S
    if len(finite) < 2:
        return minimum
    ambiguity = max(0.0, min(1.0, math.exp(finite[1] - finite[0])))
    return minimum + ambiguity * (maximum - minimum)


def _scored_actions(
    result: Dict[str, Any],
    legal_actions: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    choices = result.get("choices") or []
    choice_by_id = {
        str(choice.get("candidateId") or ""): choice
        for choice in choices
        if isinstance(choice, dict)
    }
    scored = []
    for action in legal_actions:
        candidate_id = str(action.get("id") or "")
        choice = choice_by_id[candidate_id]
        raw_value = choice.get("rawValue")
        probability = choice.get("probability")
        has_value = (
            isinstance(raw_value, (int, float))
            and not isinstance(raw_value, bool)
            and math.isfinite(float(raw_value))
        )
        has_probability = (
            isinstance(probability, (int, float))
            and not isinstance(probability, bool)
            and math.isfinite(float(probability))
            and 0 <= float(probability) <= 1
        )
        scored.append({
            **copy.deepcopy(action),
            "candidateId": candidate_id,
            "scoreGroupId": str(choice.get("scoreGroupId") or candidate_id),
            "value": float(raw_value) if has_value else 0.0,
            "probability": float(probability) if has_probability else None,
            "bar": float(probability) if has_probability else 0.0,
            "hasValue": has_value,
            "hasProbability": has_probability,
            "metrics": copy.deepcopy(choice.get("metrics") or {}),
            "isBest": candidate_id == str(result.get("bestCandidateId") or ""),
        })

    primary_metric_id = str(result.get("primaryMetricId") or "")
    primary_definition = next(
        (
            metric
            for metric in result.get("metricDefinitions") or []
            if isinstance(metric, dict)
            and str(metric.get("id") or "") == primary_metric_id
        ),
        {},
    )
    ranked_values = sorted(
        {item["value"] for item in scored if item["hasValue"]},
        reverse=str(primary_definition.get("preferredDirection") or "higher") != "lower",
    )
    ranks = {value: index + 1 for index, value in enumerate(ranked_values)}
    for item in scored:
        item["rank"] = ranks.get(item["value"], 0)
    return scored


def _best_action(
    result: Dict[str, Any],
    legal_actions: List[Dict[str, Any]],
) -> Dict[str, Any]:
    best_id = str(result.get("bestCandidateId") or "")
    action = next(
        (
            copy.deepcopy(item)
            for item in legal_actions
            if str(item.get("id") or "") == best_id
        ),
        {"type": "none"},
    )
    action.pop("id", None)
    action.pop("label", None)
    return action


def _request_recommendation(
    pool: Any,
    *,
    seat: int,
    weight_path: str,
    role: str,
    priority: str,
    events: List[Dict[str, Any]],
    legal_actions: Optional[List[Dict[str, Any]]],
    position_id: str,
    caller: str,
) -> tuple[Dict[str, Any], List[Dict[str, Any]]]:
    if not legal_actions:
        raise ValueError("Action recommendation requires host legal actions.")
    result = pool.analyze_candidates(
        seat,
        weight_path,
        role,
        events,
        legal_actions,
        position_id=position_id,
        priority=priority,
    )
    _store_debug(caller=caller, seat=seat, events=events, result=result)
    return result, _scored_actions(result, legal_actions)


def choose_ai_action(
    pool: Any,
    snapshot: Dict[str, Any],
    seat: int,
    model_path: str,
    mjai_events: Optional[List[Dict[str, Any]]] = None,
    mjai_prefix_hashes: Optional[List[int]] = None,
    mjai_events_hash: Optional[int] = None,
    accumulate_thinking: bool = True,
    legal_actions: Optional[List[Dict[str, Any]]] = None,
    position_id: str = "",
) -> Dict[str, Any]:
    del mjai_prefix_hashes, mjai_events_hash
    events = mjai_events if mjai_events is not None else build_mjai_stream(snapshot, seat)
    response, scored = _request_recommendation(
        pool,
        seat=seat,
        weight_path=model_path,
        role="play",
        priority="play",
        events=events,
        legal_actions=legal_actions,
        position_id=position_id,
        caller="choose_ai_action",
    )
    result = _best_action(response, legal_actions or [])
    thinking_time_s = _compute_thinking_time([
        entry["value"]
        for entry in scored
        if entry.get("hasValue")
    ])
    if accumulate_thinking:
        _accumulate_thinking_time(thinking_time_s)
    meta = dict(result.get("meta") or {})
    meta["thinking_time_s"] = thinking_time_s
    meta["engineFingerprint"] = str(response.get("engineFingerprint") or "")
    result["meta"] = meta
    return result


def analyze_discard_choices(
    pool: Any,
    snapshot: Dict[str, Any],
    seat: int,
    model_path: str,
    mjai_events: Optional[List[Dict[str, Any]]] = None,
    mjai_prefix_hashes: Optional[List[int]] = None,
    mjai_events_hash: Optional[int] = None,
    legal_actions: Optional[List[Dict[str, Any]]] = None,
    role: str = "recommendation",
    position_id: str = "",
) -> Dict[str, Any]:
    del mjai_prefix_hashes, mjai_events_hash
    events = mjai_events if mjai_events is not None else build_mjai_stream(snapshot, seat)
    response, scored = _request_recommendation(
        pool,
        seat=seat,
        weight_path=model_path,
        role=role,
        priority="background" if role == "auto-analysis" else "interactive",
        events=events,
        legal_actions=legal_actions,
        position_id=position_id,
        caller="analyze_discard_choices",
    )
    entries = [
        {key: copy.deepcopy(value) for key, value in entry.items() if key != "id"}
        for entry in scored
    ]
    return {
        "model": str(response.get("engineId") or "action-recommendation-engine"),
        "engineFingerprint": str(response.get("engineFingerprint") or ""),
        "hostPostprocessorVersion": "decision-analysis-v2",
        "seat": seat,
        "bestAction": _best_action(response, legal_actions or []),
        "metricDefinitions": copy.deepcopy(response.get("metricDefinitions") or []),
        "primaryMetricId": str(response.get("primaryMetricId") or ""),
        "recommendationMetricId": str(response.get("recommendationMetricId") or ""),
        "discardEntries": [entry for entry in entries if entry.get("type") == "dahai"],
        "specialEntries": [entry for entry in entries if entry.get("type") != "dahai"],
    }


def analyze_action_choices(
    pool: Any,
    snapshot: Dict[str, Any],
    seat: int,
    model_path: str,
    mjai_events: Optional[List[Dict[str, Any]]] = None,
    mjai_prefix_hashes: Optional[List[int]] = None,
    mjai_events_hash: Optional[int] = None,
    legal_actions: Optional[List[Dict[str, Any]]] = None,
    role: str = "recommendation",
    position_id: str = "",
) -> Dict[str, Any]:
    del mjai_prefix_hashes, mjai_events_hash
    events = mjai_events if mjai_events is not None else build_mjai_stream(snapshot, seat)
    response, scored = _request_recommendation(
        pool,
        seat=seat,
        weight_path=model_path,
        role=role,
        priority="background" if role == "auto-analysis" else "interactive",
        events=events,
        legal_actions=legal_actions,
        position_id=position_id,
        caller="analyze_action_choices",
    )
    return {
        "mode": "reaction",
        "model": str(response.get("engineId") or "action-recommendation-engine"),
        "engineFingerprint": str(response.get("engineFingerprint") or ""),
        "hostPostprocessorVersion": "decision-analysis-v2",
        "seat": seat,
        "bestAction": _best_action(response, legal_actions or []),
        "metricDefinitions": copy.deepcopy(response.get("metricDefinitions") or []),
        "primaryMetricId": str(response.get("primaryMetricId") or ""),
        "recommendationMetricId": str(response.get("recommendationMetricId") or ""),
        "reactionEntries": [
            {key: copy.deepcopy(value) for key, value in entry.items() if key != "id"}
            for entry in scored
        ],
    }
