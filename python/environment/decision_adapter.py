import copy
import json
import math
import os
import pathlib
import threading
import sys
import time
from typing import Any, Callable, Dict, List, Optional

from mjai_stream import build_mjai_stream, normalize_tile_for_mjai


def get_project_root() -> pathlib.Path:
    if getattr(sys, "frozen", False):
        # PyInstaller --onedir: files are unpacked into sys._MEIPASS, not exe dir
        return pathlib.Path(sys._MEIPASS)
    return pathlib.Path(__file__).resolve().parents[2]


PROJECT_ROOT = get_project_root()

ACTION_TO_TILE = {
    0: "1m", 1: "2m", 2: "3m", 3: "4m", 4: "5m", 5: "6m", 6: "7m", 7: "8m", 8: "9m",
    9: "1p", 10: "2p", 11: "3p", 12: "4p", 13: "5p", 14: "6p", 15: "7p", 16: "8p", 17: "9p",
    18: "1s", 19: "2s", 20: "3s", 21: "4s", 22: "5s", 23: "6s", 24: "7s", 25: "8s", 26: "9s",
    27: "E", 28: "S", 29: "W", 30: "N", 31: "P", 32: "F", 33: "C",
    34: "5mr", 35: "5pr", 36: "5sr",
}


SPECIAL_ACTIONS = [
    {"index": 43, "type": "hora", "label": "Ron"},
    {"index": 42, "type": "daiminkan", "label": "Kan"},
    {"index": 41, "type": "pon", "label": "Pon"},
    {"index": 38, "type": "chi_low", "label": "Chi Low"},
    {"index": 39, "type": "chi_mid", "label": "Chi Mid"},
    {"index": 40, "type": "chi_high", "label": "Chi High"},
    {"index": 45, "type": "none", "label": "Pass"},
]

DEBUG_MJAI = os.environ.get("MJAI_DEBUG", "").lower() in ("1", "true", "yes", "on")



def to_relative_model_path(model_path: str) -> str:
    path = pathlib.Path(model_path)
    if path.is_absolute():
        return str(path)
    return str(PROJECT_ROOT / path)




def normalize_tile(tile: Optional[str]) -> str:
    return str(tile or "").replace("mr", "m").replace("pr", "p").replace("sr", "s")


def build_discard_entries_from_snapshot(
    snapshot: Dict[str, Any],
    seat: int,
    q_row: List[Any],
    mask_row: List[Any],
) -> tuple[List[Dict[str, Any]], Dict[int, str]]:
    discard_entries = []
    index_to_tile = {}
    for action_index, enabled in enumerate(mask_row[:37]):
        if not enabled:
            continue
        value = q_row[action_index] if action_index < len(q_row) else None
        if not isinstance(value, (int, float)):
            continue
        tile = ACTION_TO_TILE.get(action_index)
        if tile is None:
            continue
        index_to_tile[action_index] = tile
        discard_entries.append(
            {
                "pai": tile,
                "value": float(value),
            }
        )
    return discard_entries, index_to_tile


def tile_parts(tile: str) -> tuple[Optional[int], Optional[str]]:
    normalized = normalize_tile(tile)
    if len(normalized) != 2 or normalized[0] not in "123456789":
        return None, None
    return int(normalized[0]), normalized[1]


def find_matching_tile(hand: List[str], target_tile: str, used_indexes: set[int]) -> Optional[str]:
    normalized_target = normalize_tile(target_tile)
    candidates: List[tuple[int, str]] = []
    for index, tile in enumerate(hand):
        if index in used_indexes:
            continue
        if normalize_tile(tile) == normalized_target:
            candidates.append((index, tile))
    if not candidates:
        return None
    # Prefer red tiles (e.g. 5mr over 5m)
    candidates.sort(key=lambda item: (0 if item[1].endswith("r") else 1, item[0]))
    best_index, best_tile = candidates[0]
    used_indexes.add(best_index)
    return best_tile


def build_chi_consumed(snapshot: Dict[str, Any], seat: int, variant: str) -> List[str]:
    pending_discard = snapshot.get("pendingDiscard") or {}
    discard_tile = pending_discard.get("pai")
    hand = snapshot.get("hands", [[], [], [], []])[seat]
    number, suit = tile_parts(str(discard_tile or ""))
    if number is None or suit is None:
        return []

    needed_numbers = {
        "chi_low": [number + 1, number + 2],
        "chi_mid": [number - 1, number + 1],
        "chi_high": [number - 2, number - 1],
    }.get(variant)
    if not needed_numbers or any(value < 1 or value > 9 for value in needed_numbers):
        return []

    consumed: List[str] = []
    used_indexes: set[int] = set()
    for target_number in needed_numbers:
        matched_tile = find_matching_tile(hand, f"{target_number}{suit}", used_indexes)
        if matched_tile is None:
            return []
        consumed.append(matched_tile)
    return consumed


def build_reaction_label(action_type: str, consumed: List[str], pai: Optional[str]) -> str:
    if action_type.startswith("chi"):
        sequence = " ".join(consumed + ([str(pai)] if pai else []))
        ordered = " ".join(sorted(sequence.split(), key=lambda item: (item[-1], int(item[0])))) if sequence else ""
        return f"Chi {ordered}".strip()
    if action_type == "pon" and pai:
        return f"Pon {pai}"
    if action_type == "daiminkan" and pai:
        return f"Kan {pai}"
    if action_type == "hora":
        return "Ron"
    if action_type == "none":
        return "Pass"
    return action_type


def build_self_kan_response(snapshot: Dict[str, Any], seat: int) -> Dict[str, Any]:
    hand = list(snapshot.get("hands", [[], [], [], []])[seat])
    melds = list(snapshot.get("melds", [[], [], [], []])[seat])

    for meld in melds:
        if meld.get("type") != "pon":
            continue
        family = normalize_tile(str(meld.get("pai") or ""))
        matching_tile = next((tile for tile in hand if normalize_tile(tile) == family), None)
        if matching_tile is None:
            continue
        consumed = [str(tile) for tile in list(meld.get("consumed") or [])]
        called_tile = str(meld.get("pai") or matching_tile)
        while len(consumed) < 3:
            consumed.append(called_tile)
        return {
            "type": "kakan",
            "actor": seat,
            "pai": matching_tile,
            "consumed": consumed[:3],
        }

    grouped_hand: Dict[str, List[str]] = {}
    for tile in hand:
        grouped_hand.setdefault(normalize_tile(tile), []).append(tile)
    for tiles in grouped_hand.values():
        if len(tiles) >= 4:
            return {
                "type": "ankan",
                "actor": seat,
                "consumed": tiles[:4],
            }

    return {
        "type": "kan",
        "actor": seat,
    }


def build_parsed_response_from_snapshot(
    snapshot: Dict[str, Any],
    seat: int,
    action_index: Optional[int],
) -> Dict[str, Any]:
    if action_index is None:
        return {"type": "none", "actor": seat}

    if 0 <= action_index <= 36:
        pai = ACTION_TO_TILE.get(action_index)
        action_history = snapshot.get("actionHistory") or []
        tsumo_tile = None
        if action_history:
            last_action = action_history[-1]
            if last_action.get("type") == "tsumo" and int(last_action.get("actor", -1)) == seat:
                tsumo_tile = last_action.get("pai")
        return {
            "type": "dahai",
            "actor": seat,
            "pai": pai,
            "tsumogiri": normalize_tile(tsumo_tile) == normalize_tile(pai) and str(tsumo_tile or "") == str(pai),
        }

    if action_index == 37:
        return {
            "type": "reach",
            "actor": seat,
        }

    if action_index in (38, 39, 40):
        pending_discard = snapshot.get("pendingDiscard") or {}
        return {
            "type": "chi",
            "actor": seat,
            "target": int(pending_discard.get("actor", 0)),
            "pai": pending_discard.get("pai"),
        }

    if action_index == 41:
        pending_discard = snapshot.get("pendingDiscard") or {}
        return {
            "type": "pon",
            "actor": seat,
            "target": int(pending_discard.get("actor", 0)),
            "pai": pending_discard.get("pai"),
            "consumed": [pending_discard.get("pai"), pending_discard.get("pai")],
        }

    if action_index == 42:
        phase = str(snapshot.get("phase") or "")
        if phase in ("discard", "draw_or_discard", "reach_declaration") and int(snapshot.get("currentActor", -1)) == seat:
            return build_self_kan_response(snapshot, seat)
        pending_discard = snapshot.get("pendingDiscard") or {}
        return {
            "type": "daiminkan",
            "actor": seat,
            "target": int(pending_discard.get("actor", 0)),
            "pai": pending_discard.get("pai"),
            "consumed": [pending_discard.get("pai"), pending_discard.get("pai"), pending_discard.get("pai")],
        }

    if action_index == 43:
        phase = str(snapshot.get("phase") or "")
        if phase in ("reaction_window", "kan_reaction_window"):
            pending_discard = snapshot.get("pendingDiscard") or {}
            pending_kan = snapshot.get("pendingKan") or {}
            target = int(pending_discard.get("actor", pending_kan.get("actor", seat)))
            pai = pending_discard.get("pai") or pending_kan.get("pai")
        else:
            target = seat
            pai = None
            action_history = snapshot.get("actionHistory") or []
            if action_history:
                last_action = action_history[-1]
                if last_action.get("type") == "tsumo" and int(last_action.get("actor", -1)) == seat:
                    pai = last_action.get("pai")
        return {
            "type": "hora",
            "actor": seat,
            "target": target,
            "pai": pai,
        }

    if action_index == 44:
        return {
            "type": "ryukyoku",
            "actor": seat,
        }

    if action_index == 45:
        return {
            "type": "none",
            "actor": seat,
        }

    return {"type": "none", "actor": seat}


def enrich_action_response(snapshot: Dict[str, Any], response: Dict[str, Any], action_index: Optional[int]) -> Dict[str, Any]:
    enriched = copy.deepcopy(response)
    if action_index is None:
        return enriched

    if action_index in (38, 39, 40):
        variant = {38: "chi_low", 39: "chi_mid", 40: "chi_high"}[action_index]
        consumed = build_chi_consumed(snapshot, int(enriched.get("actor", -1)), variant)
        enriched["variant"] = variant
        enriched["consumed"] = consumed
        enriched["label"] = build_reaction_label(variant, consumed, enriched.get("pai"))
    elif action_index == 41:
        enriched["variant"] = "pon"
        enriched["label"] = build_reaction_label("pon", list(enriched.get("consumed", [])), enriched.get("pai"))
    elif action_index == 42 and enriched.get("type") == "daiminkan":
        enriched["variant"] = "daiminkan"
        enriched["label"] = build_reaction_label("daiminkan", list(enriched.get("consumed", [])), enriched.get("pai"))
    elif action_index == 43:
        enriched["variant"] = "hora"
        enriched["label"] = "Ron"
    elif action_index == 45:
        enriched["variant"] = "none"
        enriched["label"] = "Pass"

    meta = copy.deepcopy(enriched.get("meta") or {})
    meta["action_index"] = action_index
    enriched["meta"] = meta
    return enriched


def build_reaction_entries_from_raw(
    snapshot: Dict[str, Any],
    seat: int,
    parsed_response: Optional[Dict[str, Any]],
    q_row: List[Any],
    mask_row: List[Any],
    probability_row: Optional[List[Any]] = None,
) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    reaction_entries: List[Dict[str, Any]] = []
    enabled_entries: List[Dict[str, Any]] = []
    for action_def in SPECIAL_ACTIONS:
        index = action_def["index"]
        enabled = bool(index < len(mask_row) and mask_row[index])
        if not enabled:
            continue

        value = q_row[index] if index < len(q_row) else None
        if not isinstance(value, (int, float)):
            continue

        action_type = action_def["type"]
        consumed: List[str] = []
        pai = None
        variant = action_type
        if action_type.startswith("chi_"):
            consumed = build_chi_consumed(snapshot, seat, action_type)
            pai = (snapshot.get("pendingDiscard") or {}).get("pai")
        elif action_type in ("pon", "daiminkan"):
            pai = (snapshot.get("pendingDiscard") or {}).get("pai")

        label = build_reaction_label(action_type, consumed, pai)
        enabled_entries.append(
            {
                "actionIndex": index,
                "type": "chi" if action_type.startswith("chi_") else action_type,
                "variant": variant,
                "label": label,
                "pai": pai,
                "consumed": consumed,
                "value": float(value),
                "probability": (
                    float(probability_row[index])
                    if isinstance(probability_row, list)
                    and index < len(probability_row)
                    and isinstance(probability_row[index], (int, float))
                    else 0.0
                ),
            }
        )

    if enabled_entries:
        ranked_by_value = sorted(enabled_entries, key=lambda item: item["value"], reverse=True)
        rank_map = {entry["actionIndex"]: rank + 1 for rank, entry in enumerate(ranked_by_value)}
    else:
        rank_map = {}

    for index, entry in enumerate(enabled_entries):
        reaction_entries.append(
            {
                **entry,
                "probability": entry.get("probability", 0.0),
                "rank": rank_map.get(entry["actionIndex"], index + 1),
                "bar": entry.get("probability", 0.0),
                "isBest": bool(parsed_response and entry["actionIndex"] == (parsed_response.get("meta") or {}).get("action_index")),
            }
        )

    best_action = copy.deepcopy(parsed_response) if isinstance(parsed_response, dict) else {"type": "none", "actor": seat}
    return reaction_entries, best_action


def _print_mjai_debug(
    snapshot: Dict[str, Any],
    seat: int,
    mjai_events: List[Dict[str, Any]],
    response: Dict[str, Any],
    caller: str,
) -> None:
    timing = response.get("timing", {})
    skip = (response.get("response") or response or {}).get("skip_reason", "")

    if not DEBUG_MJAI:
        # Always store full mjai events for F1 debug even when console output is off
        phase = snapshot.get("phase", "?")
        current_actor = snapshot.get("currentActor", "?")
        action_type = (response.get("response") or response or {}).get("type", "?")
        raw_actions = (response.get("raw_response") or {}).get("actions", [])
        err = response.get("error", "")
        _store_mjai_debug(
            mjai_events,
            caller,
            seat,
            phase,
            current_actor,
            action_type,
            raw_actions,
            timing,
            skip,
            err,
        )
        return

    phase = snapshot.get("phase", "?")
    current_actor = snapshot.get("currentActor", "?")
    tail_events = mjai_events[-6:] if len(mjai_events) > 6 else mjai_events
    action_type = (response.get("response") or response or {}).get("type", "?")
    raw_actions = (response.get("raw_response") or {}).get("actions", [])

    lines = [
        f"[MJAI_DEBUG] {caller} seat={seat} phase={phase} actor={current_actor}",
        f"[MJAI_DEBUG] --- mjai stream (last {len(tail_events)}/{len(mjai_events)}) ---",
    ]
    for event in tail_events:
        lines.append(f"[MJAI_DEBUG]   {json.dumps(event, ensure_ascii=False)}")
    lines.append("[MJAI_DEBUG] --- model response ---")
    lines.append(f"[MJAI_DEBUG]   type={action_type}  raw_actions={raw_actions}  timing_ms={timing}")
    if skip:
        lines.append(f"[MJAI_DEBUG]   skip_reason={skip}")
    err = response.get("error", "")
    if err:
        lines.append(f"[MJAI_DEBUG]   error={err}")

    for line in lines:
        print(line)

    # Always store full mjai events for F1 debug
    _store_mjai_debug(
        mjai_events,
        caller,
        seat,
        phase,
        current_actor,
        action_type,
        raw_actions,
        timing,
        skip,
        err,
    )


_LATEST_MJAI_DEBUG: Dict[str, Any] = {}


def _store_mjai_debug(
    mjai_events: List[Dict[str, Any]],
    caller: str,
    seat: int,
    phase: str,
    current_actor: Any,
    action_type: str,
    raw_actions: Any,
    timing: Dict[str, Any],
    skip: str,
    err: str,
) -> None:
    global _LATEST_MJAI_DEBUG
    _LATEST_MJAI_DEBUG = {
        "caller": caller,
        "seat": seat,
        "phase": phase,
        "actor": current_actor,
        "eventCount": len(mjai_events),
        "events": mjai_events,
        "responseType": action_type,
        "rawActions": raw_actions,
        "timing": timing,
        "skipReason": skip or None,
        "error": err or None,
    }


def get_latest_mjai_debug() -> Dict[str, Any]:
    return dict(_LATEST_MJAI_DEBUG)


_ACCUMULATED_THINKING_TIME_S: float = 0.0
_THINKING_TIME_MIN_S: float = 0.5
_THINKING_TIME_MAX_S: float = 1.0


def _accumulate_thinking_time(thinking_time_s: float) -> None:
    global _ACCUMULATED_THINKING_TIME_S
    if thinking_time_s > _ACCUMULATED_THINKING_TIME_S:
        _ACCUMULATED_THINKING_TIME_S = thinking_time_s


def get_and_reset_ai_thinking_time_s() -> float:
    global _ACCUMULATED_THINKING_TIME_S
    result = _ACCUMULATED_THINKING_TIME_S
    _ACCUMULATED_THINKING_TIME_S = 0.0
    return result


_RESPONSE_TIMES_BY_SEAT: List[List[float]] = [[], [], [], []]
_RESPONSE_TIMES_MAXLEN = 10
_RESPONSE_TIMES_LOCK = threading.Lock()


def _record_response_from_result(seat: int, response: Dict[str, Any]) -> None:
    timing = response.get("timing", {}) if isinstance(response, dict) else {}
    response_body = (response.get("response") or response) if isinstance(response, dict) else {}
    skip = response_body.get("skip_reason", "") if isinstance(response_body, dict) else ""
    total = timing.get("total_ms") if isinstance(timing, dict) else None
    if not isinstance(total, (int, float)) or not math.isfinite(float(total)) or total <= 0 or skip:
        return

    normalized_seat = int(seat) % 4
    with _RESPONSE_TIMES_LOCK:
        seat_times = _RESPONSE_TIMES_BY_SEAT[normalized_seat]
        seat_times.append(float(total))
        del seat_times[:-_RESPONSE_TIMES_MAXLEN]


def get_response_ms_by_seat() -> List[float]:
    with _RESPONSE_TIMES_LOCK:
        return [
            sum(values) / len(values) if values else 0.0
            for values in _RESPONSE_TIMES_BY_SEAT
        ]


def set_thinking_time_bounds(min_s: float, max_s: float) -> None:
    global _THINKING_TIME_MIN_S, _THINKING_TIME_MAX_S
    _THINKING_TIME_MIN_S = max(0.0, float(min_s))
    _THINKING_TIME_MAX_S = max(_THINKING_TIME_MIN_S, float(max_s))


def _compute_model_thinking_time_s(q_values: Optional[List[float]], mask_row: Optional[List[Any]] = None) -> float:
    """根据 Q 值歧义程度计算模型思考时间（秒），供前端延迟展示使用。

    percentage = exp(次优Q - 最优Q)，范围 [0, 1]
    thinking_time = min_s + percentage * (max_s - min_s)
    一选显著优于二选 → percentage ≈ 0 → 接近 min_s
    二选接近一选     → percentage ≈ 1 → 接近 max_s
    """
    if not q_values:
        return _THINKING_TIME_MIN_S

    valid: List[float] = []
    if isinstance(mask_row, list) and len(mask_row) == len(q_values):
        for q, allowed in zip(q_values, mask_row):
            if not allowed:
                continue
            if isinstance(q, (int, float)) and math.isfinite(q):
                valid.append(float(q))
    else:
        valid = [float(v) for v in q_values if isinstance(v, (int, float)) and math.isfinite(v)]
    if len(valid) < 2:
        return _THINKING_TIME_MIN_S

    valid.sort(reverse=True)
    best_q = valid[0]
    second_best_q = valid[1]

    percentage = math.exp(second_best_q - best_q)
    percentage = max(0.0, min(1.0, percentage))
    return _THINKING_TIME_MIN_S + percentage * (_THINKING_TIME_MAX_S - _THINKING_TIME_MIN_S)


def _uses_generic_decision_protocol(pool: Any) -> bool:
    method = getattr(pool, "uses_generic_protocol", None)
    return bool(callable(method) and method())


def _generic_scored_actions(
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
        has_value = isinstance(raw_value, (int, float)) and math.isfinite(float(raw_value))
        has_probability = (
            isinstance(probability, (int, float))
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
    metric_definitions = result.get("metricDefinitions") or []
    primary_definition = next((
        metric
        for metric in metric_definitions
        if isinstance(metric, dict) and str(metric.get("id") or "") == primary_metric_id
    ), {})
    ranked_values = sorted(
        {item["value"] for item in scored if item["hasValue"]},
        reverse=str(primary_definition.get("preferredDirection") or "higher") != "lower",
    )
    ranks = {value: index + 1 for index, value in enumerate(ranked_values)}
    for item in scored:
        item["rank"] = ranks.get(item["value"], 0)
    return scored


def _generic_best_action(
    result: Dict[str, Any],
    legal_actions: List[Dict[str, Any]],
) -> Dict[str, Any]:
    best_id = str(result.get("bestCandidateId") or "")
    action = next(
        (copy.deepcopy(item) for item in legal_actions if str(item.get("id") or "") == best_id),
        {"type": "none"},
    )
    action.pop("id", None)
    action.pop("label", None)
    return action


def _generic_decision(
    pool: Any,
    snapshot: Dict[str, Any],
    seat: int,
    model_path: str,
    role: str,
    priority: str,
    mjai_events: List[Dict[str, Any]],
    legal_actions: Optional[List[Dict[str, Any]]],
    position_id: str = "",
) -> tuple[Dict[str, Any], List[Dict[str, Any]]]:
    if not legal_actions:
        raise ValueError("Generic decision engine requires host legal actions.")
    result = pool.analyze_candidates(
        seat,
        model_path,
        role,
        mjai_events,
        legal_actions,
        position_id=position_id,
        priority=priority,
    )
    return result, _generic_scored_actions(result, legal_actions)


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
    if mjai_events is None:
        mjai_events = build_mjai_stream(snapshot, seat)
    if _uses_generic_decision_protocol(pool):
        response, scored = _generic_decision(
            pool,
            snapshot,
            seat,
            model_path,
            "play",
            "play",
            mjai_events,
            legal_actions,
            position_id,
        )
        result = _generic_best_action(response, legal_actions or [])
        thinking_time_s = _compute_model_thinking_time_s(
            [float(entry["value"]) for entry in scored if entry.get("hasValue")],
        )
        if accumulate_thinking:
            _accumulate_thinking_time(thinking_time_s)
        meta = dict(result.get("meta", {}))
        meta["thinking_time_s"] = thinking_time_s
        meta["engineFingerprint"] = str(response.get("engineFingerprint") or "")
        result["meta"] = meta
        return result
    response = pool.react(
        seat,
        model_path,
        "play",
        mjai_events,
        event_prefix_hashes=mjai_prefix_hashes,
        event_hash=mjai_events_hash,
    )

    _print_mjai_debug(snapshot, seat, mjai_events, response, "choose_ai_action")

    action_index = None
    q_values: Optional[List[float]] = None
    mask_row: List[Any] = []
    if isinstance(response, dict):
        raw_response = response.get("raw_response") if isinstance(response.get("raw_response"), dict) else {}
        actions = raw_response.get("actions")
        if isinstance(actions, list) and actions:
            try:
                action_index = int(actions[0])
            except (TypeError, ValueError):
                action_index = None
        q_out = raw_response.get("q_out")
        masks = raw_response.get("masks")
        if q_out and len(q_out) > 0:
            q_values = [float(v) if isinstance(v, (int, float)) and math.isfinite(v) else float("-inf") for v in q_out[0]]
        if masks and len(masks) > 0 and isinstance(masks[0], list):
            mask_row = masks[0]

    if not isinstance(response, dict):
        raise ValueError("Decision engine returned an unexpected response type.")

    if response.get("skip_reason") == "not_actionable":
        return {
            "type": "none",
            "actor": seat,
            "meta": {
                "skip_reason": "not_actionable",
            },
        }

    parsed_response = build_parsed_response_from_snapshot(snapshot, seat, action_index)
    result = enrich_action_response(snapshot, parsed_response, action_index)
    if result.get("type") == "dahai" and action_index is not None and 0 <= action_index <= 36 and mask_row:
        _, index_to_tile = build_discard_entries_from_snapshot(snapshot, seat, q_values or [], mask_row)
        mapped_tile = index_to_tile.get(action_index)
        if mapped_tile:
            result["pai"] = mapped_tile
            tsumo_tile = None
            action_history = snapshot.get("actionHistory") or []
            if action_history:
                last_action = action_history[-1]
                if last_action.get("type") == "tsumo" and int(last_action.get("actor", -1)) == seat:
                    tsumo_tile = last_action.get("pai")
            result["tsumogiri"] = normalize_tile(tsumo_tile) == normalize_tile(mapped_tile) and str(tsumo_tile or "") == str(mapped_tile)
    thinking_time_s = _compute_model_thinking_time_s(q_values, mask_row)
    if accumulate_thinking:
        _accumulate_thinking_time(thinking_time_s)
    meta = dict(result.get("meta", {}))
    meta["thinking_time_s"] = thinking_time_s
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
    if mjai_events is None:
        mjai_events = build_mjai_stream(snapshot, seat)
    if _uses_generic_decision_protocol(pool):
        response, scored = _generic_decision(
            pool,
            snapshot,
            seat,
            model_path,
            role,
            "background" if role == "auto-analysis" else "interactive",
            mjai_events,
            legal_actions,
            position_id,
        )
        discard_entries = []
        special_entries = []
        for entry in scored:
            normalized = {
                key: copy.deepcopy(value)
                for key, value in entry.items()
                if key != "id"
            }
            if entry.get("type") == "dahai":
                discard_entries.append(normalized)
            else:
                special_entries.append(normalized)
        best_action = _generic_best_action(response, legal_actions or [])
        return {
            "model": str(response.get("engineId") or "decision-engine"),
            "engineFingerprint": str(response.get("engineFingerprint") or ""),
            "hostPostprocessorVersion": "decision-analysis-v2",
            "seat": seat,
            "bestAction": best_action,
            "metricDefinitions": copy.deepcopy(response.get("metricDefinitions") or []),
            "primaryMetricId": str(response.get("primaryMetricId") or ""),
            "recommendationMetricId": str(response.get("recommendationMetricId") or ""),
            "discardEntries": discard_entries,
            "specialEntries": special_entries,
        }
    response = pool.react(
        seat,
        model_path,
        "analysis",
        mjai_events,
        event_prefix_hashes=mjai_prefix_hashes,
        event_hash=mjai_events_hash,
    )

    _print_mjai_debug(snapshot, seat, mjai_events, response, "analyze_discard")

    raw_response = response.get("raw_response") if isinstance(response, dict) else None
    q_out = raw_response.get("q_out") if isinstance(raw_response, dict) else None
    masks = raw_response.get("masks") if isinstance(raw_response, dict) else None
    probability_rows = raw_response.get("probabilities") if isinstance(raw_response, dict) else None
    actions = raw_response.get("actions") if isinstance(raw_response, dict) else None
    best_action_index = None
    if isinstance(actions, list) and actions:
        try:
            best_action_index = int(actions[0])
        except (TypeError, ValueError):
            best_action_index = None

    q_row = q_out[0] if isinstance(q_out, list) and q_out and isinstance(q_out[0], list) else []
    mask_row = masks[0] if isinstance(masks, list) and masks and isinstance(masks[0], list) else []
    probability_row = probability_rows[0] if isinstance(probability_rows, list) and probability_rows and isinstance(probability_rows[0], list) else []

    discard_entries, index_to_tile = build_discard_entries_from_snapshot(snapshot, seat, q_row, mask_row)
    special_entries = []
    for action_index, enabled in enumerate(mask_row):
        if not enabled or 0 <= action_index <= 36:
            continue
        value = q_row[action_index] if action_index < len(q_row) else None
        if not isinstance(value, (int, float)):
            continue
        if action_index == 37:
            special_entries.append(
                {
                    "type": "reach",
                    "variant": "declare",
                    "label": "Riichi",
                    "value": float(value),
                }
            )
            continue
        if action_index == 43:
            special_entries.append(
                {
                    "type": "hora",
                    "variant": "tsumo",
                    "label": "Tsumo",
                    "value": float(value),
                }
            )
            continue
        if action_index == 42:
            kan_response = build_parsed_response_from_snapshot(snapshot, seat, action_index)
            variant = str(kan_response.get("type") or "kan")
            label = "Closed Kan" if variant == "ankan" else ("Add Kan" if variant == "kakan" else "Kan")
            special_entries.append(
                {
                    "type": variant,
                    "variant": variant,
                    "label": label,
                    "pai": kan_response.get("pai"),
                    "consumed": copy.deepcopy(kan_response.get("consumed") or []),
                    "value": float(value),
                }
            )
            continue
        if action_index == 44:
            special_entries.append(
                {
                    "type": "ryukyoku",
                    "variant": "kyuushu_kyuuhai",
                    "label": "Abortive Draw",
                    "value": float(value),
                }
            )

    tile_to_index = {tile: index for index, tile in index_to_tile.items()}
    for entry in discard_entries:
        action_index = tile_to_index.get(entry.get("pai"), -1)
        probability = probability_row[action_index] if 0 <= action_index < len(probability_row) else 0.0
        entry["probability"] = float(probability)
        entry["bar"] = float(probability)
    for entry in special_entries:
        action_index = {
            "reach": 37,
            "ankan": 42,
            "kakan": 42,
            "hora": 43,
            "ryukyoku": 44,
        }.get(str(entry.get("type")), -1)
        probability = probability_row[action_index] if 0 <= action_index < len(probability_row) else 0.0
        entry["probability"] = float(probability)
        entry["bar"] = float(probability)

    # Rank within each category (preserve existing semantics)
    discard_entries.sort(key=lambda item: item["value"], reverse=True)
    for index, entry in enumerate(discard_entries):
        entry["rank"] = index + 1

    special_entries.sort(key=lambda item: item["value"], reverse=True)
    for index, entry in enumerate(special_entries):
        entry["rank"] = index + 1

    best_action = enrich_action_response(snapshot, build_parsed_response_from_snapshot(snapshot, seat, best_action_index), best_action_index)
    if isinstance(best_action_index, int) and best_action and best_action.get("type") == "dahai":
        mapped_tile = index_to_tile.get(best_action_index)
        if mapped_tile:
            best_action["pai"] = mapped_tile
            action_history = snapshot.get("actionHistory") or []
            tsumo_tile = None
            if action_history:
                last_action = action_history[-1]
                if last_action.get("type") == "tsumo" and int(last_action.get("actor", -1)) == seat:
                    tsumo_tile = last_action.get("pai")
            best_action["tsumogiri"] = normalize_tile(tsumo_tile) == normalize_tile(mapped_tile) and str(tsumo_tile or "") == str(mapped_tile)

    return {
        "model": str(response.get("engineId") or "decision-engine"),
        "engineFingerprint": str(response.get("engineFingerprint") or ""),
        "hostPostprocessorVersion": "decision-analysis-v2",
        "seat": seat,
        "bestAction": best_action,
        "discardEntries": discard_entries,
        "specialEntries": special_entries,
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
    if mjai_events is None:
        mjai_events = build_mjai_stream(snapshot, seat)
    if _uses_generic_decision_protocol(pool):
        response, scored = _generic_decision(
            pool,
            snapshot,
            seat,
            model_path,
            role,
            "background" if role == "auto-analysis" else "interactive",
            mjai_events,
            legal_actions,
            position_id,
        )
        best_action = _generic_best_action(response, legal_actions or [])
        reaction_entries = []
        for entry in scored:
            reaction_entries.append({
                key: copy.deepcopy(value)
                for key, value in entry.items()
                if key != "id"
            })
        return {
            "mode": "reaction",
            "model": str(response.get("engineId") or "decision-engine"),
            "engineFingerprint": str(response.get("engineFingerprint") or ""),
            "hostPostprocessorVersion": "decision-analysis-v2",
            "seat": seat,
            "bestAction": best_action,
            "metricDefinitions": copy.deepcopy(response.get("metricDefinitions") or []),
            "primaryMetricId": str(response.get("primaryMetricId") or ""),
            "recommendationMetricId": str(response.get("recommendationMetricId") or ""),
            "reactionEntries": reaction_entries,
        }
    event_hash = (
        mjai_events_hash
        if mjai_events_hash is not None
        else hash(tuple(json.dumps(event, sort_keys=True, ensure_ascii=False) for event in mjai_events))
    )
    response = pool.react(
        seat,
        model_path,
        "analysis",
        mjai_events,
        event_prefix_hashes=mjai_prefix_hashes,
        event_hash=event_hash,
    )

    _print_mjai_debug(snapshot, seat, mjai_events, response, "analyze_actions")

    raw_response = response.get("raw_response") if isinstance(response, dict) else None
    skip_reason = response.get("skip_reason") if isinstance(response, dict) else None
    q_out = raw_response.get("q_out") if isinstance(raw_response, dict) else None
    masks = raw_response.get("masks") if isinstance(raw_response, dict) else None
    probability_rows = raw_response.get("probabilities") if isinstance(raw_response, dict) else None

    if skip_reason == "not_actionable":
        return {
            "mode": "reaction",
            "model": str(response.get("engineId") or "decision-engine"),
            "engineFingerprint": str(response.get("engineFingerprint") or ""),
            "hostPostprocessorVersion": "decision-analysis-v2",
            "seat": seat,
            "bestAction": {"type": "none", "actor": seat},
            "reactionEntries": [],
        }

    q_row = q_out[0] if isinstance(q_out, list) and q_out and isinstance(q_out[0], list) else []
    mask_row = masks[0] if isinstance(masks, list) and masks and isinstance(masks[0], list) else []
    probability_row = probability_rows[0] if isinstance(probability_rows, list) and probability_rows and isinstance(probability_rows[0], list) else []

    best_action_index = None
    if isinstance(raw_response, dict):
        actions = raw_response.get("actions")
        if isinstance(actions, list) and actions:
            try:
                best_action_index = int(actions[0])
            except (TypeError, ValueError):
                best_action_index = None

    best_action = enrich_action_response(snapshot, build_parsed_response_from_snapshot(snapshot, seat, best_action_index), best_action_index)

    reaction_entries, best_action = build_reaction_entries_from_raw(
        snapshot,
        seat,
        best_action,
        q_row,
        mask_row,
        probability_row,
    )

    result = {
        "mode": "reaction",
        "model": str(response.get("engineId") or "decision-engine"),
        "engineFingerprint": str(response.get("engineFingerprint") or ""),
        "hostPostprocessorVersion": "decision-analysis-v2",
        "seat": seat,
        "bestAction": best_action,
        "reactionEntries": reaction_entries,
    }
    return result
