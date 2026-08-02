"""Convert a public Mortal review report into a read-only replay game."""

from __future__ import annotations

import copy
import math
import re
from typing import Any, Dict, List


_WINDS = {"E": 0, "S": 1, "W": 2, "N": 3}
_READ_ONLY_REASON_CODE = "missing-complete-wall"
OFFICIAL_MORTAL_REPORT_SOURCE_ID = "official-mortal-report"
_SUPPORTED_EVENTS = {
    "tsumo",
    "dahai",
    "chi",
    "pon",
    "daiminkan",
    "ankan",
    "kakan",
    "reach",
    "reach_accepted",
    "dora",
    "hora",
    "ryukyoku",
}

_TENHOU_YAKU_NAMES = {
    "門前清自摸和": "Menzen Tsumo",
    "立直": "Riichi",
    "一発": "Ippatsu",
    "平和": "Pinfu",
    "断幺九": "Tanyao",
    "一盃口": "Iipeiko",
    "役牌白": "Yakuhai (haku)",
    "役牌發": "Yakuhai (hatsu)",
    "役牌発": "Yakuhai (hatsu)",
    "役牌中": "Yakuhai (chun)",
    "自風東": "Yakuhai (seat wind east)",
    "自風南": "Yakuhai (seat wind south)",
    "自風西": "Yakuhai (seat wind west)",
    "自風北": "Yakuhai (seat wind north)",
    "場風東": "Yakuhai (round wind east)",
    "場風南": "Yakuhai (round wind south)",
    "場風西": "Yakuhai (round wind west)",
    "場風北": "Yakuhai (round wind north)",
    "嶺上開花": "Rinshan Kaihou",
    "槍槓": "Chankan",
    "搶槓": "Chankan",
    "海底摸月": "Haitei Raoyue",
    "河底撈魚": "Houtei Raoyui",
    "ダブル立直": "Double Riichi",
    "七対子": "Chiitoitsu",
    "混全帯幺九": "Chantai",
    "一気通貫": "Ittsu",
    "三色同順": "Sanshoku Doujun",
    "三色同刻": "Sanshoku Doukou",
    "三暗刻": "San Ankou",
    "三槓子": "San Kantsu",
    "対々和": "Toitoi",
    "混老頭": "Honroutou",
    "小三元": "Shou Sangen",
    "混一色": "Honitsu",
    "純全帯幺九": "Junchan",
    "二盃口": "Ryanpeikou",
    "清一色": "Chinitsu",
    "流し満貫": "Nagashi Mangan",
    "ドラ": "Dora",
    "赤ドラ": "Aka Dora",
    "裏ドラ": "Ura Dora",
    "国士無双": "Kokushi Musou",
    "四暗刻": "Suu Ankou",
    "大三元": "Daisangen",
    "小四喜": "Shousuushii",
    "緑一色": "Ryuuiisou",
    "四槓子": "Suu Kantsu",
    "字一色": "Tsuu Iisou",
    "清老頭": "Chinroutou",
    "九蓮宝燈": "Chuuren Poutou",
    "天和": "Tenhou",
    "地和": "Chiihou",
    "国士無双13面": "Kokushi Musou Juusanmen Matchi",
    "四暗刻単騎": "Suu Ankou Tanki",
    "純正九蓮宝燈": "Daburu Chuuren Poutou",
    "大四喜": "Dai Suushii",
}

_TENHOU_LIMIT_LEVELS = {
    "数え役満": "kazoe yakuman",
    "役満": "yakuman",
    "三倍満": "sanbaiman",
    "倍満": "baiman",
    "跳満": "haneman",
    "満貫": "mangan",
}


def _sort_tiles(tiles: List[str]) -> List[str]:
    suits = {"m": 0, "p": 1, "s": 2}
    honors = {"E": 30, "S": 31, "W": 32, "N": 33, "P": 34, "F": 35, "C": 36}

    def key(tile: str):
        if tile in honors:
            return (3, honors[tile], tile)
        base = tile.replace("r", "")
        return (suits.get(base[1], 9), int(base[0]) + (0.5 if tile.endswith("r") else 0), tile)

    return sorted((str(tile) for tile in tiles), key=key)


def _int_list(value: Any, length: int) -> List[int] | None:
    if not isinstance(value, list) or len(value) != length:
        return None
    try:
        return [int(item) for item in value]
    except (TypeError, ValueError):
        return None


def _safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _canonical_tenhou_yaku_name(name: str) -> str:
    compact = re.sub(r"\s+", "", str(name or ""))
    return _TENHOU_YAKU_NAMES.get(compact, str(name or "").strip())


def _parse_tenhou_yaku(raw_value: Any) -> Dict[str, Any] | None:
    text = str(raw_value or "").strip()
    if not text or text == "不明":
        return None
    match = re.match(r"^(.*?)[(（]\s*(\d+)\s*[飜翻]\s*[)）]$", text)
    if match:
        return {
            "name": _canonical_tenhou_yaku_name(match.group(1)),
            "han": int(match.group(2)),
            "isYakuman": False,
        }
    if "役満" in text:
        name = re.sub(r"[(（].*?[)）]$", "", text).strip()
        return {
            "name": _canonical_tenhou_yaku_name(name),
            "han": 13,
            "isYakuman": True,
        }
    return None


def _parse_tenhou_win_detail(raw_detail: Any) -> Dict[str, Any] | None:
    if not isinstance(raw_detail, list) or len(raw_detail) < 4:
        return None
    try:
        actor = int(raw_detail[0])
        target = int(raw_detail[1])
        liable_player = int(raw_detail[2])
    except (TypeError, ValueError):
        return None
    if actor not in range(4) or target not in range(4) or liable_player not in range(4):
        return None

    score_text = str(raw_detail[3] or "").strip()
    fu_match = re.search(r"(\d+)\s*符", score_text)
    han_match = re.search(r"(\d+)\s*[飜翻]", score_text)
    yaku_details = [
        parsed
        for parsed in (_parse_tenhou_yaku(value) for value in raw_detail[4:])
        if parsed is not None
    ]
    han = int(han_match.group(1)) if han_match else sum(int(item["han"]) for item in yaku_details)
    cost: Dict[str, Any] = {}
    for label, level in _TENHOU_LIMIT_LEVELS.items():
        if label in score_text:
            cost["yaku_level"] = level
            break
    return {
        "actor": actor,
        "target": target,
        "liablePlayer": liable_player,
        "scoreText": score_text,
        "fu": int(fu_match.group(1)) if fu_match else None,
        "han": han or None,
        "yakuDetails": yaku_details,
        "cost": cost,
    }


def _parse_tenhou_round_result(raw_result: Any) -> Dict[str, Any] | None:
    if not isinstance(raw_result, list) or not raw_result:
        return None
    label = str(raw_result[0] or "").strip()
    deltas = _int_list(raw_result[1] if len(raw_result) > 1 else None, 4)
    if label == "和了":
        return {
            "kind": "hora",
            "label": label,
            "deltas": deltas,
            "wins": [
                parsed
                for parsed in (_parse_tenhou_win_detail(value) for value in raw_result[2:])
                if parsed is not None
            ],
        }
    if label:
        return {
            "kind": "ryukyoku",
            "label": label if label != "不明" else "流局",
            "deltas": deltas,
            "wins": [],
        }
    return None


def _extract_round_settlements(report: Dict[str, Any]) -> Dict[tuple[int, int, int], List[Dict[str, Any]]]:
    settlements: Dict[tuple[int, int, int], List[Dict[str, Any]]] = {}
    split_logs = report.get("split_logs")
    if not isinstance(split_logs, list):
        return settlements
    for split in split_logs:
        logs = split.get("log") if isinstance(split, dict) else None
        if not isinstance(logs, list):
            continue
        for round_log in logs:
            if not isinstance(round_log, list) or len(round_log) < 2:
                continue
            round_head = _int_list(round_log[0], 3)
            if round_head is None:
                continue
            parsed = _parse_tenhou_round_result(round_log[-1])
            if parsed is not None:
                settlements.setdefault(tuple(round_head), []).append(parsed)
    return settlements


def _take_win_detail(settlement: Dict[str, Any] | None, event: Dict[str, Any]) -> Dict[str, Any] | None:
    if not settlement:
        return None
    wins = settlement.get("wins")
    if not isinstance(wins, list) or not wins:
        return None
    actor = int(event.get("actor", -1))
    target = int(event.get("target", actor))
    index = next(
        (
            idx
            for idx, detail in enumerate(wins)
            if int(detail.get("actor", -1)) == actor and int(detail.get("target", -1)) == target
        ),
        None,
    )
    if index is None:
        index = next(
            (idx for idx, detail in enumerate(wins) if int(detail.get("actor", -1)) == actor),
            None,
        )
    if index is None:
        return None
    return wins.pop(index)


def _round_index(event: Dict[str, Any]) -> int:
    return _WINDS.get(str(event.get("bakaze") or "E"), 0) * 4 + max(0, int(event.get("kyoku") or 1) - 1)


def _new_round_snapshot(event: Dict[str, Any], match_id: str) -> Dict[str, Any]:
    hands = event.get("tehais")
    if not isinstance(hands, list) or len(hands) != 4:
        raise ValueError("Mortal report start_kyoku is missing four starting hands.")
    reported_initial_hands = [[str(tile) for tile in hand] for hand in hands]
    initial_hands = [_sort_tiles(list(hand)) for hand in reported_initial_hands]
    scores = [int(value) for value in event.get("scores", [25000] * 4)]
    if len(scores) != 4:
        raise ValueError("Mortal report start_kyoku has invalid scores.")
    dealer = int(event.get("oya", 0))
    dora_marker = str(event.get("dora_marker") or "")
    snapshot = {
        "initialHands": copy.deepcopy(initial_hands),
        # Keep the report's original order for later wall reconstruction while
        # retaining sorted hands for table rendering and game logic.
        "reportedInitialHands": copy.deepcopy(reported_initial_hands),
        "startScores": scores[:],
        "startKyotaku": int(event.get("kyotaku", 0)),
        "fullWall": [],
        "hands": copy.deepcopy(initial_hands),
        "rivers": [[], [], [], []],
        # Only the remaining count is known. Tile identities are deliberately absent.
        "wall": ["?"] * 122,
        "rinshanWall": [],
        "drawIndex": 52,
        "dealer": dealer,
        "currentActor": dealer,
        "phase": "draw_or_discard",
        "turn": 0,
        "doraIndicators": [dora_marker] if dora_marker else [],
        "uraIndicators": [],
        "doraIndicatorStack": [],
        "uraIndicatorStack": [],
        "bakaze": str(event.get("bakaze") or "E"),
        "kyoku": int(event.get("kyoku") or 1),
        "honba": int(event.get("honba") or 0),
        "kyotaku": int(event.get("kyotaku") or 0),
        "scores": scores[:],
        "roundIndex": _round_index(event),
        "westEntered": str(event.get("bakaze") or "E") in ("W", "N"),
        "inRenchan": False,
        "lastAction": {"type": "start_kyoku", "source": "mortal-report"},
        "melds": [[], [], [], []],
        "riichiDeclared": [False, False, False, False],
        "riichiAccepted": [False, False, False, False],
        "ippatsuEligible": [False, False, False, False],
        "pendingRiichiSeat": None,
        "riichiDiscardState": None,
        "pendingRiichiDiscard": None,
        "pendingKan": None,
        "pendingRinshanDraw": False,
        "pendingDiscard": None,
        "reactionWindow": None,
        "kanReactionWindow": None,
        "actionHistory": [],
        "matchId": match_id,
    }
    return snapshot


def _remove_tile(hand: List[str], tile: str) -> None:
    if tile in hand:
        hand.remove(tile)
        return
    family = tile.replace("r", "")
    for index, candidate in enumerate(hand):
        if candidate.replace("r", "") == family:
            hand.pop(index)
            return


def _finalize_pending_discard(snapshot: Dict[str, Any]) -> None:
    pending = snapshot.get("pendingDiscard")
    if pending:
        snapshot["rivers"][int(pending["actor"])].append(str(pending["pai"]))
    snapshot["pendingDiscard"] = None
    snapshot["reactionWindow"] = None


def _reaction_window(discard: Dict[str, Any]) -> Dict[str, Any]:
    actor = int(discard["actor"])
    return {
        "discard": copy.deepcopy(discard),
        "reactions": [{"seat": seat, "response": {"type": "none", "actor": seat}} for seat in range(4) if seat != actor],
    }


def _apply_event(snapshot: Dict[str, Any], raw_event: Dict[str, Any]) -> Dict[str, Any]:
    # The raw dealing order is only needed on the round-start snapshot.
    snapshot.pop("reportedInitialHands", None)
    event = copy.deepcopy(raw_event)
    event_type = str(event.get("type") or "")
    if event_type not in _SUPPORTED_EVENTS:
        raise ValueError(f"Unsupported mjai event in Mortal report: {event_type}")

    if event_type != "dahai":
        _finalize_pending_discard(snapshot)

    if event_type == "tsumo":
        actor = int(event["actor"])
        tile = str(event.get("pai") or "")
        snapshot["hands"][actor].append(tile)
        snapshot["hands"][actor] = _sort_tiles(snapshot["hands"][actor])
        snapshot["drawIndex"] += 1
        snapshot["currentActor"] = actor
        snapshot["phase"] = "discard"
        snapshot["pendingRinshanDraw"] = False

    elif event_type == "dahai":
        actor = int(event["actor"])
        tile = str(event.get("pai") or "")
        _remove_tile(snapshot["hands"][actor], tile)
        is_riichi = snapshot.get("pendingRiichiSeat") == actor
        event["riichi"] = bool(event.get("riichi", is_riichi))
        discard = {
            "actor": actor,
            "pai": tile,
            "tsumogiri": bool(event.get("tsumogiri")),
            "targetActor": (actor + 1) % 4,
            "riichi": bool(event["riichi"]),
        }
        snapshot["pendingDiscard"] = discard
        snapshot["reactionWindow"] = _reaction_window(discard)
        snapshot["currentActor"] = actor
        snapshot["phase"] = "reaction_window"
        snapshot["turn"] += 1

    elif event_type == "reach":
        actor = int(event["actor"])
        snapshot["riichiDeclared"][actor] = True
        snapshot["pendingRiichiSeat"] = actor
        snapshot["currentActor"] = actor
        snapshot["phase"] = "reach_declaration"

    elif event_type == "reach_accepted":
        actor = int(event["actor"])
        if not snapshot["riichiAccepted"][actor]:
            snapshot["scores"][actor] -= 1000
            snapshot["kyotaku"] += 1
        snapshot["riichiDeclared"][actor] = True
        snapshot["riichiAccepted"][actor] = True
        snapshot["ippatsuEligible"][actor] = True
        snapshot["pendingRiichiSeat"] = None
        snapshot["currentActor"] = (actor + 1) % 4
        snapshot["phase"] = "draw_or_discard"

    elif event_type in ("chi", "pon", "daiminkan"):
        actor = int(event["actor"])
        if event.get("target") is not None:
            # Local records use `from` to lay out the called tile and mark it in the river.
            event["from"] = int(event["target"])
        for tile in event.get("consumed", []):
            _remove_tile(snapshot["hands"][actor], str(tile))
        snapshot["melds"][actor].append(copy.deepcopy(event))
        snapshot["ippatsuEligible"] = [False, False, False, False]
        snapshot["currentActor"] = actor
        snapshot["phase"] = "draw_or_discard" if event_type == "daiminkan" else "discard"
        snapshot["pendingRinshanDraw"] = event_type == "daiminkan"

    elif event_type == "ankan":
        actor = int(event["actor"])
        for tile in event.get("consumed", []):
            _remove_tile(snapshot["hands"][actor], str(tile))
        snapshot["melds"][actor].append(copy.deepcopy(event))
        snapshot["ippatsuEligible"] = [False, False, False, False]
        snapshot["currentActor"] = actor
        snapshot["phase"] = "draw_or_discard"
        snapshot["pendingRinshanDraw"] = True

    elif event_type == "kakan":
        actor = int(event["actor"])
        tile = str(event.get("pai") or "")
        _remove_tile(snapshot["hands"][actor], tile)
        upgraded = False
        for meld in snapshot["melds"][actor]:
            if meld.get("type") == "pon" and str(meld.get("pai") or "").replace("r", "") == tile.replace("r", ""):
                meld.update(copy.deepcopy(event))
                meld["type"] = "kakan"
                upgraded = True
                break
        if not upgraded:
            snapshot["melds"][actor].append(copy.deepcopy(event))
        snapshot["ippatsuEligible"] = [False, False, False, False]
        snapshot["currentActor"] = actor
        snapshot["phase"] = "draw_or_discard"
        snapshot["pendingRinshanDraw"] = True

    elif event_type == "dora":
        marker = str(event.get("dora_marker") or "")
        if marker:
            snapshot["doraIndicators"].append(marker)

    elif event_type == "hora":
        actor = int(event["actor"])
        target = int(event.get("target", actor))
        if not event.get("pai"):
            if target == actor:
                for action in reversed(snapshot.get("actionHistory", [])):
                    if action.get("type") == "tsumo" and int(action.get("actor", -1)) == actor:
                        event["pai"] = action.get("pai")
                        break
            else:
                river = snapshot["rivers"][target]
                if river:
                    event["pai"] = river[-1]
        event["isTsumo"] = target == actor
        event["uraMarkers"] = copy.deepcopy(event.get("ura_markers") or [])
        deltas = _int_list(event.get("deltas"), 4) or [0, 0, 0, 0]
        event["deltas"] = deltas
        snapshot["uraIndicators"] = copy.deepcopy(event["uraMarkers"])
        snapshot["currentActor"] = actor
        snapshot["phase"] = "game_end"

    elif event_type == "ryukyoku":
        deltas = _int_list(event.get("deltas"), 4) or [0, 0, 0, 0]
        event["deltas"] = deltas
        if isinstance(event.get("tehais"), list):
            event["tenpaiSeats"] = [seat for seat, hand in enumerate(event["tehais"]) if hand]
        snapshot["phase"] = "game_end"

    snapshot["lastAction"] = copy.deepcopy(event)
    snapshot["actionHistory"].append(copy.deepcopy(event))
    return snapshot


def _build_round_result_snapshot(
    snapshot: Dict[str, Any],
    terminal_events: List[Dict[str, Any]],
    settlement: Dict[str, Any] | None,
) -> Dict[str, Any]:
    result_snapshot = copy.deepcopy(snapshot)
    hora_events = [copy.deepcopy(event) for event in terminal_events if event.get("type") == "hora"]
    ryukyoku_events = [copy.deepcopy(event) for event in terminal_events if event.get("type") == "ryukyoku"]
    settlement_deltas = _int_list((settlement or {}).get("deltas"), 4)
    if settlement_deltas is None:
        event_deltas = [_int_list(event.get("deltas"), 4) or [0, 0, 0, 0] for event in terminal_events]
        settlement_deltas = [
            sum(deltas[seat] for deltas in event_deltas)
            for seat in range(4)
        ]

    if hora_events:
        event_data = hora_events[0]
        event_data["deltas"] = settlement_deltas
        if len(hora_events) > 1:
            event_data["horaEvents"] = hora_events
        result = {
            "roundIndex": int(result_snapshot.get("roundIndex", 0)),
            "canRenchan": any(int(event.get("actor", -1)) == int(result_snapshot.get("dealer", 0)) for event in hora_events),
            "hasHora": True,
            "hasAbortiveRyukyoku": False,
            "kyotakuLeft": 0,
            "scores": [
                score + settlement_deltas[seat]
                for seat, score in enumerate(result_snapshot.get("scores", [25000] * 4))
            ],
            "eventType": "hora",
            "eventData": event_data,
        }
    else:
        event_data = ryukyoku_events[0] if ryukyoku_events else {"type": "ryukyoku"}
        event_data["deltas"] = settlement_deltas
        event_data["reasonLabel"] = str((settlement or {}).get("label") or event_data.get("reasonLabel") or "流局")
        event_data.setdefault("reason", "exhaustive_draw" if event_data["reasonLabel"] == "流局" else "ryukyoku")
        tenpai_seats = event_data.get("tenpaiSeats") if isinstance(event_data.get("tenpaiSeats"), list) else []
        result = {
            "roundIndex": int(result_snapshot.get("roundIndex", 0)),
            "canRenchan": int(result_snapshot.get("dealer", 0)) in tenpai_seats,
            "hasHora": False,
            "hasAbortiveRyukyoku": event_data["reason"] != "exhaustive_draw",
            "kyotakuLeft": int(result_snapshot.get("kyotaku", 0)),
            "scores": [
                score + settlement_deltas[seat]
                for seat, score in enumerate(result_snapshot.get("scores", [25000] * 4))
            ],
            "eventType": "ryukyoku",
            "eventData": event_data,
        }

    result_snapshot["phase"] = "round_result"
    result_snapshot["lastAction"] = {
        "type": "round_result",
        "result": result,
        "source": "mortal-report",
    }
    result_snapshot["actionHistory"].append(copy.deepcopy(result_snapshot["lastAction"]))
    return result_snapshot


def _review_action_variant(action: Dict[str, Any], reaction: bool) -> str:
    action_type = str(action.get("type") or "")
    if action_type == "chi":
        called = str(action.get("pai") or "").replace("r", "")
        consumed = [str(tile).replace("r", "") for tile in action.get("consumed") or []]
        if len(called) == 2 and called[0].isdigit() and len(consumed) == 2:
            numbers = sorted(int(tile[0]) for tile in consumed if len(tile) == 2 and tile[0].isdigit())
            if len(numbers) == 2:
                called_number = int(called[0])
                if numbers == [called_number + 1, called_number + 2]:
                    return "chi_low"
                if numbers == [called_number - 1, called_number + 1]:
                    return "chi_mid"
                if numbers == [called_number - 2, called_number - 1]:
                    return "chi_high"
        return "chi"
    if action_type == "reach":
        return "declare"
    if action_type == "hora":
        return "hora" if reaction else "tsumo"
    if action_type in ("ankan", "kakan"):
        tile = str(action.get("pai") or next(iter(action.get("consumed") or []), ""))
        return f"{action_type}:{tile.replace('r', '')}" if tile else action_type
    if action_type == "ryukyoku":
        return "kyuushu_kyuuhai"
    return action_type


def _normalize_review_action(action: Any, controlled_seat: int, reaction: bool) -> Dict[str, Any] | None:
    if not isinstance(action, dict):
        return None
    action_type = str(action.get("type") or "")
    if not action_type:
        return None
    normalized = {
        "type": action_type,
        "actor": _safe_int(action.get("actor"), controlled_seat),
    }
    for key in ("target", "pai", "tsumogiri"):
        if key in action:
            normalized[key] = copy.deepcopy(action[key])
    if isinstance(action.get("consumed"), list):
        normalized["consumed"] = [str(tile) for tile in action["consumed"]]
    normalized["variant"] = _review_action_variant(normalized, reaction)
    return normalized


def _review_action_signature(action: Dict[str, Any] | None) -> tuple[Any, ...]:
    if not isinstance(action, dict):
        return ()
    return (
        action.get("type"),
        action.get("variant"),
        action.get("pai"),
        action.get("target"),
        action.get("tsumogiri"),
        tuple(sorted(str(tile) for tile in action.get("consumed") or [])),
    )


def _review_action_label(action: Dict[str, Any]) -> str:
    return {
        "none": "Pass",
        "chi": "Chi",
        "pon": "Pon",
        "daiminkan": "Kan",
        "ankan": "Closed Kan",
        "kakan": "Add Kan",
        "reach": "Riichi",
        "hora": "Ron" if action.get("variant") == "hora" else "Tsumo",
        "ryukyoku": "Abortive Draw",
    }.get(str(action.get("type") or ""), str(action.get("type") or ""))


def _build_review_analysis(entry: Dict[str, Any], snapshot: Dict[str, Any], controlled_seat: int) -> Dict[str, Any] | None:
    reaction = str(snapshot.get("phase") or "") in ("reaction_window", "kan_reaction_window")
    expected = _normalize_review_action(entry.get("expected"), controlled_seat, reaction)
    expected_signature = _review_action_signature(expected)
    scored: List[Dict[str, Any]] = []
    details = entry.get("details")
    if not isinstance(details, list):
        return None
    for detail in details:
        if not isinstance(detail, dict):
            continue
        action = _normalize_review_action(detail.get("action"), controlled_seat, reaction)
        try:
            value = float(detail.get("q_value"))
            probability = float(detail.get("prob"))
        except (TypeError, ValueError):
            continue
        if (
            action is None
            or not math.isfinite(value)
            or not math.isfinite(probability)
            or probability < 0
            or probability > 1
        ):
            continue
        compact_action = {
            key: copy.deepcopy(action[key])
            for key in ("type", "variant", "pai", "tsumogiri", "consumed")
            if key in action
        }
        scored.append({
            **compact_action,
            "label": _review_action_label(action),
            "value": value,
            "probability": probability,
            "isBest": _review_action_signature(action) == expected_signature,
        })
    if not scored:
        return None
    if expected is None:
        expected = copy.deepcopy(max(scored, key=lambda item: float(item["probability"])))
        for key in ("label", "value", "probability", "isBest"):
            expected.pop(key, None)
        expected_signature = _review_action_signature(expected)
        for item in scored:
            item["isBest"] = _review_action_signature(item) == expected_signature

    ranked = sorted(scored, key=lambda item: float(item["value"]), reverse=True)
    for rank, item in enumerate(ranked, start=1):
        item["rank"] = rank

    result: Dict[str, Any] = {
        "error": None,
        "model": "Mortal 官方分析",
        "seat": controlled_seat,
        "bestAction": expected,
    }
    if reaction:
        result["mode"] = "reaction"
        result["reactionEntries"] = ranked
    else:
        result["discardEntries"] = [item for item in ranked if item.get("type") == "dahai"]
        result["specialEntries"] = [item for item in ranked if item.get("type") != "dahai"]
    return result


def _review_entry_is_reaction(entry: Dict[str, Any], controlled_seat: int) -> bool:
    actual = entry.get("actual") if isinstance(entry.get("actual"), dict) else {}
    action_type = str(actual.get("type") or "")
    if action_type in ("chi", "pon", "daiminkan"):
        return True
    if action_type == "hora":
        return _safe_int(actual.get("target"), controlled_seat) != controlled_seat
    return _safe_int(entry.get("last_actor"), controlled_seat) != controlled_seat and action_type not in (
        "dahai", "reach", "ankan", "kakan", "ryukyoku"
    )


def _review_entry_matches_node(entry: Dict[str, Any], node: Dict[str, Any], controlled_seat: int) -> bool:
    snapshot = node.get("snapshot") or {}
    hands = snapshot.get("hands") or [[], [], [], []]
    state = entry.get("state") if isinstance(entry.get("state"), dict) else {}
    reported_hand = state.get("tehai")
    if not isinstance(reported_hand, list) or controlled_seat >= len(hands):
        return False
    if sorted(str(tile) for tile in hands[controlled_seat]) != sorted(str(tile) for tile in reported_hand):
        return False

    if _review_entry_is_reaction(entry, controlled_seat):
        if snapshot.get("phase") not in ("reaction_window", "kan_reaction_window"):
            return False
        pending = snapshot.get("pendingDiscard") or snapshot.get("pendingKan") or {}
        return (
            _safe_int(pending.get("actor"), -1) == _safe_int(entry.get("last_actor"), -2)
            and str(pending.get("pai") or "") == str(entry.get("tile") or "")
        )
    return snapshot.get("phase") in ("discard", "reach_declaration") and _safe_int(
        snapshot.get("currentActor"), -1
    ) == controlled_seat


def attach_mortal_review_cache(
    game: Dict[str, Any],
    report: Dict[str, Any],
    controlled_seat: int,
    cache_version: int,
) -> Dict[str, Dict[str, Any]]:
    """Attach compact official review rows as stale decision caches."""
    review = report.get("review") if isinstance(report, dict) else None
    rounds = review.get("kyokus") if isinstance(review, dict) else None
    if not isinstance(rounds, list):
        return {}

    nodes = sorted(
        (node for node in (game.get("nodes") or {}).values() if isinstance(node, dict)),
        key=lambda node: (int(node.get("depth", 0)), str(node.get("id") or "")),
    )
    attached: Dict[str, Dict[str, Any]] = {}
    for round_review in rounds:
        if not isinstance(round_review, dict):
            continue
        try:
            round_index = int(round_review.get("kyoku"))
            honba = int(round_review.get("honba") or 0)
        except (TypeError, ValueError):
            continue
        last_depth = -1
        round_nodes = [
            node for node in nodes
            if _safe_int((node.get("snapshot") or {}).get("roundIndex"), -1) == round_index
            and _safe_int((node.get("snapshot") or {}).get("honba"), -1) == honba
        ]
        entries = round_review.get("entries")
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            matching = next(
                (
                    node for node in round_nodes
                    if int(node.get("depth", 0)) > last_depth
                    and _review_entry_matches_node(entry, node, controlled_seat)
                ),
                None,
            )
            if matching is None:
                continue
            last_depth = int(matching.get("depth", 0))
            snapshot = matching.get("snapshot") or {}
            analysis = _build_review_analysis(entry, snapshot, controlled_seat)
            if analysis is None:
                continue
            phase = str(snapshot.get("phase") or "")
            if phase == "draw_or_discard":
                phase = "discard"
            cache_key = (
                f"m{int(cache_version)}::{controlled_seat}::{phase}::"
                f"{OFFICIAL_MORTAL_REPORT_SOURCE_ID}"
            )
            matching.setdefault("analysisCache", {})[cache_key] = analysis
            attached[str(matching.get("id") or "")] = analysis
    return attached


def build_mortal_report_game(
    report: Dict[str, Any],
    source_url: str,
    game_id: str,
    created_at: str,
) -> tuple[Dict[str, Any], int]:
    if not isinstance(report, dict):
        raise ValueError("Mortal report must be a JSON object.")
    events = report.get("mjai_log")
    if not isinstance(events, list) or not events:
        raise ValueError("The downloaded file has no mjai_log.")
    start_events = [event for event in events if isinstance(event, dict) and event.get("type") == "start_kyoku"]
    if not start_events:
        raise ValueError("The downloaded mjai_log has no start_kyoku event.")

    start_game = next((event for event in events if isinstance(event, dict) and event.get("type") == "start_game"), {})
    names = list(start_game.get("names") or ["Player 1", "Player 2", "Player 3", "Player 4"])
    controlled_seat = int(report.get("player_id", 0))
    if controlled_seat not in range(4):
        controlled_seat = 0
    match_id = f"mortal_{game_id.removeprefix('game_')}"
    first_snapshot = _new_round_snapshot(start_events[0], match_id)
    round_settlements = _extract_round_settlements(report)
    nodes: Dict[str, Any] = {
        "n_root": {
            "id": "n_root",
            "type": "root",
            "parentId": None,
            "children": [],
            "mainChildId": None,
            "action": None,
            "actor": None,
            "snapshot": copy.deepcopy(first_snapshot),
            "analysisCache": {},
            "depth": 0,
        }
    }
    parent_id = "n_root"
    node_index = 1
    current_snapshot = None
    current_settlement = None
    terminal_events: List[Dict[str, Any]] = []
    first_decision_id = None

    def append_node(action: Dict[str, Any], snapshot: Dict[str, Any]) -> str:
        nonlocal parent_id, node_index, first_decision_id
        node_id = f"n_{node_index}"
        node_index += 1
        nodes[node_id] = {
            "id": node_id,
            "type": "action",
            "parentId": parent_id,
            "children": [],
            "mainChildId": None,
            "action": copy.deepcopy(action),
            "actor": action.get("actor"),
            "snapshot": copy.deepcopy(snapshot),
            "analysisCache": {},
            "depth": nodes[parent_id]["depth"] + 1,
        }
        nodes[parent_id]["children"].append(node_id)
        nodes[parent_id]["mainChildId"] = node_id
        parent_id = node_id
        if first_decision_id is None and snapshot.get("phase") == "discard" and snapshot.get("currentActor") == controlled_seat:
            first_decision_id = node_id
        return node_id

    def append_round_result_if_ready() -> None:
        nonlocal current_snapshot, terminal_events
        if current_snapshot is None or not terminal_events:
            return
        current_snapshot = _build_round_result_snapshot(current_snapshot, terminal_events, current_settlement)
        append_node(copy.deepcopy(current_snapshot["lastAction"]), current_snapshot)
        terminal_events = []

    for raw_event in events:
        if not isinstance(raw_event, dict):
            continue
        event_type = str(raw_event.get("type") or "")
        if event_type == "start_kyoku":
            append_round_result_if_ready()
            current_snapshot = _new_round_snapshot(raw_event, match_id)
            settlement_key = (
                _round_index(raw_event),
                int(raw_event.get("honba") or 0),
                int(raw_event.get("kyotaku") or 0),
            )
            matching_settlements = round_settlements.get(settlement_key) or []
            current_settlement = matching_settlements.pop(0) if matching_settlements else None
            terminal_events = []
            append_node({"type": "start_kyoku", "source": "mortal-report"}, current_snapshot)
        elif event_type in _SUPPORTED_EVENTS:
            if current_snapshot is None:
                raise ValueError("Mortal report action appeared before start_kyoku.")
            prepared_event = copy.deepcopy(raw_event)
            if event_type == "hora":
                detail = _take_win_detail(current_settlement, prepared_event)
                if detail:
                    prepared_event.update(copy.deepcopy(detail))
            elif event_type == "ryukyoku" and current_settlement:
                prepared_event["reasonLabel"] = str(current_settlement.get("label") or "流局")
            current_snapshot = _apply_event(copy.deepcopy(current_snapshot), prepared_event)
            action = copy.deepcopy(current_snapshot["lastAction"])
            action["source"] = "mortal-report"
            append_node(action, current_snapshot)
            if event_type in ("hora", "ryukyoku"):
                terminal_events.append(copy.deepcopy(action))
        elif event_type == "end_kyoku":
            append_round_result_if_ready()
        elif event_type == "end_game" and current_snapshot is not None:
            append_round_result_if_ready()
            current_snapshot = copy.deepcopy(current_snapshot)
            _finalize_pending_discard(current_snapshot)
            round_result = (
                copy.deepcopy((current_snapshot.get("lastAction") or {}).get("result") or {})
                if (current_snapshot.get("lastAction") or {}).get("type") == "round_result"
                else {}
            )
            final_scores = _int_list(round_result.get("scores"), 4) or copy.deepcopy(
                current_snapshot.get("scores", [25000] * 4)
            )
            match_result = {
                "scores": final_scores,
                "roundIndex": int(current_snapshot.get("roundIndex", 0)),
                "bakaze": current_snapshot.get("bakaze", "E"),
                "kyoku": int(current_snapshot.get("kyoku", 1)),
            }
            current_snapshot["phase"] = "match_end"
            current_snapshot["lastAction"] = {
                "type": "match_result",
                "actor": int(current_snapshot.get("dealer", 0)),
                "result": copy.deepcopy(match_result),
            }
            append_node(
                {
                    "type": "match_end",
                    "source": "mortal-report",
                    "result": copy.deepcopy(match_result),
                },
                current_snapshot,
            )

    append_round_result_if_ready()

    if parent_id == "n_root":
        raise ValueError("Mortal report did not contain replayable rounds.")

    last_snapshot = nodes[parent_id]["snapshot"]
    settled_scores = copy.deepcopy(last_snapshot.get("scores", [25000] * 4))
    for event in reversed(last_snapshot.get("actionHistory") or []):
        if event.get("type") != "round_result":
            continue
        candidate = _int_list((event.get("result") or {}).get("scores"), 4)
        if candidate is not None:
            settled_scores = candidate
        break
    match_type = "hanchan" if str(report.get("game_length") or "").lower() == "hanchan" or any(e.get("bakaze") == "S" for e in start_events) else "tonpuusen"
    match_state = {
        "matchId": match_id,
        "seed": 0,
        "matchType": match_type,
        "players": 4,
        "westEntryEnabled": True,
        "maxBakaze": "W" if match_type == "hanchan" else "S",
        "maxKyoku": 4,
        "roundSeeds": [],
        "roundIndex": int(last_snapshot.get("roundIndex", 0)),
        "bakaze": last_snapshot.get("bakaze", "E"),
        "kyoku": int(last_snapshot.get("kyoku", 1)),
        "honba": int(last_snapshot.get("honba", 0)),
        "kyotaku": int(last_snapshot.get("kyotaku", 0)),
        "dealer": int(last_snapshot.get("dealer", 0)),
        "scores": settled_scores,
        "ended": last_snapshot.get("phase") == "match_end",
    }
    game = {
        "formatVersion": 2,
        "gameId": game_id,
        "matchId": match_id,
        "seed": 0,
        "createdAt": created_at,
        "metadata": {
            "label": match_id,
            "source": "mortal-report",
            "sourceUrl": source_url,
            "readOnly": True,
            "readOnlyReason": _READ_ONLY_REASON_CODE,
            "playerNames": names,
        },
        "matchConfig": {
            "matchType": match_type,
            "players": 4,
            "westEntryEnabled": True,
            "maxBakaze": match_state["maxBakaze"],
            "maxKyoku": 4,
        },
        "matchState": match_state,
        "rootNodeId": "n_root",
        "currentNodeId": first_decision_id or nodes["n_root"]["children"][0],
        "mainLeafNodeId": parent_id,
        "nextNodeIndex": node_index,
        "pendingReview": None,
        "nodes": nodes,
    }
    return game, controlled_seat


def repair_mortal_report_game(game: Dict[str, Any]) -> Dict[str, Any]:
    """Upgrade previously saved Mortal imports to the local meld schema."""
    if not isinstance(game, dict):
        return game
    metadata = game.get("metadata")
    if not isinstance(metadata, dict) or metadata.get("source") != "mortal-report":
        return game

    if metadata.get("readOnly"):
        metadata["readOnlyReason"] = _READ_ONLY_REASON_CODE
    else:
        metadata.pop("readOnlyReason", None)

    def repair_event(event: Any) -> None:
        if not isinstance(event, dict):
            return
        if event.get("type") not in ("chi", "pon", "daiminkan", "kakan"):
            return
        if event.get("from") is None and event.get("target") is not None:
            event["from"] = int(event["target"])

    for node in (game.get("nodes") or {}).values():
        if not isinstance(node, dict):
            continue
        repair_event(node.get("action"))
        snapshot = node.get("snapshot")
        if not isinstance(snapshot, dict):
            continue
        repair_event(snapshot.get("lastAction"))
        for event in snapshot.get("actionHistory") or []:
            repair_event(event)
        for seat_melds in snapshot.get("melds") or []:
            for meld in seat_melds or []:
                repair_event(meld)
    return game
