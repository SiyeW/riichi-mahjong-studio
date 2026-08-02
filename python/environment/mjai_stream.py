"""Canonical mjai event-stream builder shared by host rules and decision engines.

This module is the single source of truth for converting the environment's
internal actionHistory into the mjai-protocol event list consumed by:
- external decision-engine inference (decision_adapter)
- pure-Python host rule state reconstruction (rule_kernel)

Previously, build_mjai_stream() and build_start_kyoku_event() were duplicated
across settlement.py and decision_adapter.py with subtle differences and missing
hora/ryukyoku handlers.  This module eliminates both problems.
"""

from typing import Any, Dict, List

SEAT_TILES_HIDDEN = ["?"] * 13

# ---------------------------------------------------------------------------
# tile helpers
# ---------------------------------------------------------------------------


def normalize_tile_for_mjai(tile: str) -> str:
    return tile.replace("5mr", "5m").replace("5pr", "5p").replace("5sr", "5s")


# ---------------------------------------------------------------------------
# start_kyoku
# ---------------------------------------------------------------------------


def build_start_kyoku_event(snapshot: Dict[str, Any], viewer_seat: int, *, reveal_all: bool = False) -> Dict[str, Any]:
    visible_tehais: List[List[str]] = []
    for seat, hand in enumerate(snapshot["initialHands"]):
        if seat == viewer_seat or reveal_all:
            visible_tehais.append([tile for tile in hand])
        else:
            visible_tehais.append(SEAT_TILES_HIDDEN[:])

    return {
        "type": "start_kyoku",
        "bakaze": snapshot["bakaze"],
        "kyoku": snapshot["kyoku"],
        "honba": snapshot["honba"],
        "kyotaku": int(snapshot.get("startKyotaku", snapshot["kyotaku"])),
        "oya": snapshot["dealer"],
        "scores": list(snapshot.get("startScores", snapshot["scores"][:])),
        "dora_marker": snapshot["doraIndicators"][0],
        "tehais": visible_tehais,
    }


# ---------------------------------------------------------------------------
# build_mjai_stream
# ---------------------------------------------------------------------------


def build_mjai_events_from_actions(actions: List[Dict[str, Any]], viewer_seat: int, *, reveal_all: bool = False) -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []

    for action in actions:
        action_type = action.get("type")
        actor = int(action.get("actor", 0))
        pai = str(action.get("pai", ""))

        if action_type == "tsumo":
            events.append(
                {
                    "type": "tsumo",
                    "actor": actor,
                    "pai": pai if (actor == viewer_seat or reveal_all) else "?",
                }
            )
        elif action_type == "dahai":
            events.append(
                {
                    "type": "dahai",
                    "actor": actor,
                    "pai": pai,
                    "tsumogiri": bool(action.get("tsumogiri")),
                }
            )
        elif action_type == "reach":
            events.append({"type": "reach", "actor": actor})
        elif action_type == "reach_accepted":
            events.append({"type": "reach_accepted", "actor": actor})
        elif action_type == "ankan":
            events.append(
                {
                    "type": "ankan",
                    "actor": actor,
                    "consumed": [str(t) for t in action.get("consumed", [])],
                }
            )
        elif action_type == "kakan":
            events.append(
                {
                    "type": "kakan",
                    "actor": actor,
                    "pai": pai,
                    "consumed": [str(t) for t in action.get("consumed", [])],
                }
            )
        elif action_type == "daiminkan":
            events.append(
                {
                    "type": "daiminkan",
                    "actor": actor,
                    "target": int(action.get("target", 0)),
                    "pai": pai,
                    "consumed": [str(t) for t in action.get("consumed", [])],
                }
            )
        elif action_type in ("chi", "pon"):
            events.append(
                {
                    "type": action_type,
                    "actor": actor,
                    "target": int(action.get("target", 0)),
                    "pai": pai,
                    "consumed": [str(t) for t in action.get("consumed", [])],
                }
            )
        elif action_type == "dora":
            events.append(
                {
                    "type": "dora",
                    "dora_marker": str(action.get("dora_marker", "")),
                }
            )
        elif action_type == "hora":
            events.append(
                {
                    "type": "hora",
                    "actor": actor,
                    "target": int(action.get("target", actor)),
                    "pai": pai,
                }
            )
        elif action_type == "ryukyoku":
            reason = str(action.get("reason", ""))
            event: Dict[str, Any] = {"type": "ryukyoku"}
            if reason:
                event["reason"] = reason
            events.append(event)

    return events


def build_mjai_stream(snapshot: Dict[str, Any], viewer_seat: int, *, reveal_all: bool = False) -> List[Dict[str, Any]]:
    events = [build_start_kyoku_event(snapshot, viewer_seat, reveal_all=reveal_all)]
    events.extend(build_mjai_events_from_actions(snapshot.get("actionHistory", []), viewer_seat, reveal_all=reveal_all))

    return events


# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------


def validate_mjai_stream(events: List[Dict[str, Any]]) -> List[str]:
    """Validate mjai event ordering. Returns list of warnings (empty means clean).

    Checks cover the most impactful known bug classes:
    - riichi declaration not followed by reach_accepted
    - kan events missing subsequent rinshan tsumo + dora pair
    - duplicate reach declarations without intervening reach_accepted
    """
    warnings: List[str] = []
    pending_reach_actor: int | None = None
    pending_kan: bool = False

    for i, event in enumerate(events):
        etype = event.get("type")

        if etype == "reach":
            if pending_reach_actor is not None:
                warnings.append(
                    f"Event {i}: duplicate reach declaration (actor {event.get('actor')}) "
                    f"before previous reach (actor {pending_reach_actor}) was accepted"
                )
            pending_reach_actor = event.get("actor")

        if etype == "reach_accepted":
            if pending_reach_actor is None:
                warnings.append(
                    f"Event {i}: reach_accepted without a preceding reach declaration"
                )
            pending_reach_actor = None

        if etype in ("ankan", "daiminkan", "kakan"):
            if pending_kan:
                warnings.append(
                    f"Event {i}: nested kan ({etype}) without rinshan+tsumo after previous kan"
                )
            pending_kan = True

        if etype == "tsumo" and pending_kan:
            pending_kan = False

        if etype == "dora" and pending_kan:
            warnings.append(
                f"Event {i}: dora revealed before rinshan tsumo after kan"
            )

    if pending_reach_actor is not None:
        warnings.append("Stream ended with unaccepted reach declaration")
    if pending_kan:
        warnings.append("Stream ended with unreconciled kan (missing rinshan tsumo)")

    return warnings
