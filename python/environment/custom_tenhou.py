from __future__ import annotations

import copy
import json
import re
from collections import Counter
from typing import Any, Dict, List, Tuple
from urllib.parse import unquote, urlsplit

from mortal_report_import import build_mortal_report_game


_WINDS = ("东", "南", "西", "北")
_HONORS = {41: "E", 42: "S", 43: "W", 44: "N", 45: "P", 46: "F", 47: "C"}
_MJAI_HONORS = {value: key for key, value in _HONORS.items()}
_MELD_RE = re.compile(r"^(?:[cpmk]?\d{2})(?:[pmk]?\d{2})?(?:[pk]?\d{2})?(?:[ma]?\d{2})?$")
_ABORT_LABELS = {
    "流局", "流し満貫", "九種九牌", "四風連打", "四槓散了", "四家立直",
    "三家和了", "全員聴牌", "全員不聴", "不明",
}


def _round_label(round_index: int, honba: int) -> str:
    wind = _WINDS[min(max(round_index // 4, 0), len(_WINDS) - 1)]
    suffix = f" {honba}本场" if honba else ""
    return f"{wind}{round_index % 4 + 1}局{suffix}"


def _fail(label: str, message: str, action_index: int | None = None) -> None:
    location = label if action_index is None else f"{label}，第 {action_index} 个动作"
    raise ValueError(f"{location}：{message}")


def _parse_json_text(value: str, context: str) -> Dict[str, Any]:
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{context}不是合法的 JSON（第 {exc.lineno} 行，第 {exc.colno} 列）。") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"{context}必须是一个天凤牌谱 JSON 对象。")
    return parsed


def _parse_tenhou_url(value: str, context: str) -> Dict[str, Any]:
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise ValueError(f"{context}不是合法的天凤牌谱地址。") from exc
    if parsed.netloc.lower() not in {"tenhou.net", "www.tenhou.net"}:
        raise ValueError(f"{context}不是 tenhou.net 的牌谱地址。")
    fragment = parsed.fragment
    if not fragment.startswith("json="):
        raise ValueError(f"{context}缺少 #json= 数据。")
    return _parse_json_text(unquote(fragment[5:]), context)


def normalize_custom_tenhou_input(raw_input: Any) -> Dict[str, Any]:
    text = str(raw_input or "").strip()
    if not text:
        raise ValueError("请输入天凤自定义牌谱 JSON 或牌谱地址。")

    if text.startswith("{"):
        documents = [_parse_json_text(text, "输入内容")]
    else:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if not lines:
            raise ValueError("输入内容为空。")
        documents = [
            _parse_tenhou_url(line, f"第 {index} 行")
            for index, line in enumerate(lines, 1)
        ]

    first = documents[0]
    first_names = first.get("name")
    first_rule = first.get("rule")
    if not isinstance(first_names, list) or len(first_names) != 4:
        raise ValueError("牌谱必须包含四个玩家姓名。")
    if not isinstance(first_rule, dict):
        raise ValueError("牌谱缺少四人麻将规则信息。")
    disp = str(first_rule.get("disp") or "")
    if "3-Player" in disp or "三" in disp:
        raise ValueError("仅支持四人麻将牌谱。")

    rounds: List[Any] = []
    for index, document in enumerate(documents, 1):
        if document.get("name") != first_names:
            raise ValueError(f"第 {index} 段牌谱的玩家姓名与第一段不一致。")
        if document.get("rule") != first_rule:
            raise ValueError(f"第 {index} 段牌谱的规则与第一段不一致。")
        document_rounds = document.get("log")
        if not isinstance(document_rounds, list) or not document_rounds:
            raise ValueError(f"第 {index} 段牌谱没有小局数据。")
        if len(documents) > 1 and len(document_rounds) != 1:
            raise ValueError(f"NAGA 多行格式的第 {index} 行必须只包含一个小局。")
        rounds.extend(copy.deepcopy(document_rounds))

    normalized = {
        "rule": copy.deepcopy(first_rule),
        "title": copy.deepcopy(first.get("title") or ["", ""]),
        "name": [str(name) for name in first_names],
        "log": rounds,
    }
    for key in ("ref", "ver"):
        if key in first:
            normalized[key] = copy.deepcopy(first[key])
    return normalized


def _tile_from_tenhou(value: Any, label: str, action_index: int | None = None) -> str:
    if isinstance(value, bool) or not isinstance(value, int):
        _fail(label, f"非法牌张编码 {value!r}", action_index)
    if value in (51, 52, 53):
        return ("5mr", "5pr", "5sr")[value - 51]
    if value in _HONORS:
        return _HONORS[value]
    suit = value // 10
    rank = value % 10
    if suit in (1, 2, 3) and 1 <= rank <= 9:
        return f"{rank}{('m', 'p', 's')[suit - 1]}"
    _fail(label, f"非法牌张编码 {value!r}", action_index)
    raise AssertionError


def _tile_to_tenhou(tile: Any) -> int:
    value = str(tile or "")
    if value in _MJAI_HONORS:
        return _MJAI_HONORS[value]
    if value in ("5mr", "5pr", "5sr"):
        return 51 + ("m", "p", "s").index(value[1])
    if len(value) == 2 and value[0].isdigit() and value[1] in "mps" and value[0] != "0":
        return ("mps".index(value[1]) + 1) * 10 + int(value[0])
    raise ValueError(f"无法导出非法牌张：{value or '空值'}")


def _tile_family(tile: str) -> str:
    return tile.replace("r", "")


def _meld_pairs(value: str, label: str, action_index: int) -> Tuple[List[int], int, str]:
    if not _MELD_RE.fullmatch(value):
        _fail(label, f"无法识别副露编码 {value!r}", action_index)
    marker_positions = [(value.index(marker), marker) for marker in "cpmka" if marker in value]
    if len(marker_positions) != 1:
        _fail(label, f"无法识别副露编码 {value!r}", action_index)
    marker_index, marker = marker_positions[0]
    digits = value.replace(marker, "")
    if len(digits) not in (6, 8) or not digits.isdigit():
        _fail(label, f"无法识别副露编码 {value!r}", action_index)
    pairs = [int(digits[index:index + 2]) for index in range(0, len(digits), 2)]
    return pairs, marker_index, marker


def _parse_meld(value: str, actor: int, label: str, action_index: int) -> Dict[str, Any]:
    pairs, marker_index, marker = _meld_pairs(value, label, action_index)
    tiles = [_tile_from_tenhou(pair, label, action_index) for pair in pairs]
    if marker == "c" and marker_index == 0 and len(tiles) == 3:
        families = [_tile_family(tile) for tile in tiles]
        if (
            any(len(tile) != 2 or tile[1] not in "mps" for tile in families)
            or len({tile[1] for tile in families}) != 1
            or sorted(int(tile[0]) for tile in families) not in ([rank, rank + 1, rank + 2] for rank in range(1, 8))
        ):
            _fail(label, f"吃牌编码 {value!r} 不是同花色的连续三张牌", action_index)
        return {"type": "chi", "actor": actor, "target": (actor + 3) % 4, "pai": tiles[0], "consumed": tiles[1:]}
    if marker == "p" and len(tiles) == 3 and marker_index in (0, 2, 4):
        if len({_tile_family(tile) for tile in tiles}) != 1:
            _fail(label, f"碰牌编码 {value!r} 包含不同牌张", action_index)
        called_index = {0: 0, 2: 1, 4: 2}[marker_index]
        direction = {0: 3, 2: 2, 4: 1}[marker_index]
        return {
            "type": "pon", "actor": actor, "target": (actor + direction) % 4,
            "pai": tiles[called_index], "consumed": [tile for index, tile in enumerate(tiles) if index != called_index],
        }
    if marker == "m" and len(tiles) == 4 and marker_index in (0, 2, 6):
        if len({_tile_family(tile) for tile in tiles}) != 1:
            _fail(label, f"大明杠编码 {value!r} 包含不同牌张", action_index)
        called_index = {0: 0, 2: 1, 6: 3}[marker_index]
        direction = {0: 3, 2: 2, 6: 1}[marker_index]
        return {
            "type": "daiminkan", "actor": actor, "target": (actor + direction) % 4,
            "pai": tiles[called_index], "consumed": [tile for index, tile in enumerate(tiles) if index != called_index],
        }
    if marker == "a" and len(tiles) == 4 and marker_index == 6:
        if len({_tile_family(tile) for tile in tiles}) != 1:
            _fail(label, f"暗杠编码 {value!r} 包含不同牌张", action_index)
        return {"type": "ankan", "actor": actor, "consumed": tiles}
    if marker == "k" and len(tiles) == 4 and marker_index in (0, 2, 4):
        if len({_tile_family(tile) for tile in tiles}) != 1:
            _fail(label, f"加杠编码 {value!r} 包含不同牌张", action_index)
        added_index = {0: 0, 2: 1, 4: 2}[marker_index]
        called_index = {0: 1, 2: 2, 4: 3}[marker_index]
        own_indices = [index for index in range(4) if index not in (added_index, called_index)]
        direction = {0: 3, 2: 2, 4: 1}[marker_index]
        return {
            "type": "kakan", "actor": actor, "target": (actor + direction) % 4,
            "pai": tiles[added_index],
            "consumed": [tiles[index] for index in own_indices] + [tiles[called_index]],
        }
    _fail(label, f"副露编码 {value!r} 的类型或来源位置不合法", action_index)
    raise AssertionError


def _remove_tile(hand: List[str], tile: str, label: str, action_index: int, reason: str) -> None:
    if tile not in hand:
        _fail(label, f"{reason}使用了手牌中不存在的 {tile}", action_index)
    hand.remove(tile)


def _known_tile_check(round_data: List[Any], label: str) -> None:
    known: Counter[str] = Counter()
    sources = list(round_data[2]) + list(round_data[3])
    for seat in range(4):
        sources.extend(round_data[4 + seat * 3])
        sources.extend(value for value in round_data[5 + seat * 3] if isinstance(value, int) and value != 0)
    for value in sources:
        tile = _tile_from_tenhou(value, label)
        known[_tile_family(tile)] += 1
        if known[_tile_family(tile)] > 4:
            _fail(label, f"已知牌张中出现了第五张 { _tile_family(tile) }")
    for red in ("5mr", "5pr", "5sr"):
        red_code = _tile_to_tenhou(red)
        if sum(1 for value in sources if value == red_code) > 1:
            _fail(label, f"已知牌张中出现了两张赤 {red[:2]}")


def _parse_end_info(raw: Any, label: str) -> Tuple[str, List[Dict[str, Any]], List[int], str]:
    if not isinstance(raw, list) or not raw or not isinstance(raw[0], str):
        _fail(label, "结算数据格式不正确")
    kind = raw[0]
    if kind == "和了":
        wins: List[Dict[str, Any]] = []
        index = 1
        while index + 1 < len(raw):
            deltas, detail = raw[index], raw[index + 1]
            if not isinstance(deltas, list) or len(deltas) != 4 or not isinstance(detail, list) or len(detail) < 4:
                _fail(label, "和了结算必须成对包含四家分数变化与和牌详情")
            if any(isinstance(value, bool) or not isinstance(value, int) for value in deltas):
                _fail(label, "和了结算的分数变化必须是整数")
            actor, target = detail[0], detail[1]
            if actor not in range(4) or target not in range(4):
                _fail(label, "和牌者或放铳者座位不正确")
            wins.append({"actor": actor, "target": target, "deltas": list(deltas), "detail": copy.deepcopy(detail)})
            index += 2
        if not wins:
            _fail(label, "和了结算没有和牌详情")
        total = [sum(win["deltas"][seat] for win in wins) for seat in range(4)]
        return kind, wins, total, kind
    if kind not in _ABORT_LABELS:
        _fail(label, f"不支持的结算类型 {kind!r}")
    deltas = raw[1] if len(raw) > 1 else [0, 0, 0, 0]
    if not isinstance(deltas, list) or len(deltas) != 4 or any(isinstance(value, bool) or not isinstance(value, int) for value in deltas):
        _fail(label, "流局结算的分数变化必须包含四个整数")
    return kind, [], list(deltas), kind


def _decode_round(round_data: Any, round_number: int) -> Tuple[List[Dict[str, Any]], List[Any]]:
    if not isinstance(round_data, list) or len(round_data) != 17:
        raise ValueError(f"第 {round_number} 个小局必须是包含 17 项的天凤小局数组。")
    header = round_data[0]
    if not isinstance(header, list) or len(header) != 3 or any(isinstance(value, bool) or not isinstance(value, int) for value in header):
        raise ValueError(f"第 {round_number} 个小局的局数、本场或场供格式不正确。")
    round_index, honba, kyotaku = header
    if round_index < 0 or honba < 0 or kyotaku < 0:
        raise ValueError(f"第 {round_number} 个小局的局数、本场或场供不能为负数。")
    if round_index > 15:
        raise ValueError(f"第 {round_number} 个小局的局数超出了四人麻将的北4局。")
    label = _round_label(round_index, honba)
    scores = round_data[1]
    if not isinstance(scores, list) or len(scores) != 4 or any(isinstance(value, bool) or not isinstance(value, int) for value in scores):
        _fail(label, "开局分数必须包含四个整数")
    if sum(scores) + kyotaku * 1000 != 100000:
        _fail(label, f"四家分数与场供合计为 {sum(scores) + kyotaku * 1000}，应为 100000")
    if not isinstance(round_data[2], list) or not round_data[2] or not isinstance(round_data[3], list):
        _fail(label, "宝牌或里宝牌指示牌格式不正确")
    for seat in range(4):
        base = 4 + seat * 3
        if not all(isinstance(round_data[base + offset], list) for offset in range(3)):
            _fail(label, f"第 {seat + 1} 家的起手牌、摸牌或出牌数据格式不正确")
        if len(round_data[base]) != 13:
            _fail(label, f"第 {seat + 1} 家的起手牌不是 13 张")
    _known_tile_check(round_data, label)
    end_kind, wins, _overall_delta, result_label = _parse_end_info(round_data[16], label)

    players = []
    hands: List[List[str]] = []
    for seat in range(4):
        base = 4 + seat * 3
        hand = [_tile_from_tenhou(value, label) for value in round_data[base]]
        hands.append(hand)
        players.append({"incoming": round_data[base + 1], "outgoing": round_data[base + 2], "in": 0, "out": 0})

    events: List[Dict[str, Any]] = [{
        "type": "start_kyoku",
        "bakaze": ("E", "S", "W", "N")[min(round_index // 4, 3)],
        "kyoku": round_index % 4 + 1,
        "honba": honba,
        "kyotaku": kyotaku,
        "oya": round_index % 4,
        "scores": list(scores),
        "dora_marker": _tile_from_tenhou(round_data[2][0], label),
        "tehais": copy.deepcopy(hands),
    }]
    actor = round_index % 4
    action_index = 0
    last_drawn: List[str | None] = [None, None, None, None]
    last_discard: Dict[str, Any] | None = None
    riichi = [False, False, False, False]
    open_hand = [False, False, False, False]
    pons: List[Dict[str, Dict[str, Any]]] = [{}, {}, {}, {}]
    running_scores = list(scores)
    dora_index = 1

    def emit(event: Dict[str, Any]) -> None:
        nonlocal action_index
        action_index += 1
        events.append(event)

    def reveal_kan_dora() -> None:
        nonlocal dora_index
        if dora_index < len(round_data[2]):
            emit({"type": "dora", "dora_marker": _tile_from_tenhou(round_data[2][dora_index], label, action_index + 1)})
            dora_index += 1

    safety_limit = sum(len(player["incoming"]) + len(player["outgoing"]) for player in players) * 3 + 32
    for _ in range(max(1, safety_limit)):
        player = players[actor]
        if player["in"] >= len(player["incoming"]):
            break
        incoming = player["incoming"][player["in"]]
        player["in"] += 1
        action_index += 1

        called_meld = None
        if isinstance(incoming, str):
            called_meld = _parse_meld(incoming, actor, label, action_index)
            if called_meld["type"] not in ("chi", "pon", "daiminkan"):
                _fail(label, f"{called_meld['type']} 不能出现在摸牌序列中", action_index)
            if last_discard is None:
                _fail(label, "副露前没有可以被鸣的弃牌", action_index)
            if called_meld["target"] != last_discard["actor"]:
                _fail(label, "副露来源与上一张弃牌的玩家不一致", action_index)
            if _tile_family(called_meld["pai"]) != _tile_family(last_discard["pai"]):
                _fail(label, "副露所鸣的牌与上一张弃牌不一致", action_index)
            if called_meld["type"] == "chi" and actor != (last_discard["actor"] + 1) % 4:
                _fail(label, "吃牌者不是弃牌者的下家", action_index)
            for tile in called_meld["consumed"]:
                _remove_tile(hands[actor], tile, label, action_index, called_meld["type"])
            open_hand[actor] = True
            if called_meld["type"] == "pon":
                pons[actor][_tile_family(called_meld["pai"])] = copy.deepcopy(called_meld)
            events.append(called_meld)
            last_drawn[actor] = None
        elif isinstance(incoming, int):
            tile = _tile_from_tenhou(incoming, label, action_index)
            hands[actor].append(tile)
            last_drawn[actor] = tile
            events.append({"type": "tsumo", "actor": actor, "pai": tile})
        else:
            _fail(label, f"无法识别摸牌数据 {incoming!r}", action_index)

        if player["out"] >= len(player["outgoing"]):
            break
        outgoing = player["outgoing"][player["out"]]
        player["out"] += 1
        action_index += 1

        if called_meld and called_meld["type"] == "daiminkan":
            if outgoing != 0:
                _fail(label, "大明杠后缺少天凤格式要求的 0 占位", action_index)
            reveal_kan_dora()
            continue

        if isinstance(outgoing, str) and any(marker in outgoing for marker in "ak"):
            meld = _parse_meld(outgoing, actor, label, action_index)
            if meld["type"] not in ("ankan", "kakan"):
                _fail(label, f"{meld['type']} 不能出现在出牌序列中", action_index)
            if meld["type"] == "ankan":
                for tile in meld["consumed"]:
                    _remove_tile(hands[actor], tile, label, action_index, "暗杠")
            else:
                family = _tile_family(meld["pai"])
                pon = pons[actor].get(family)
                if pon is None:
                    _fail(label, f"加杠前没有对应的碰 {family}", action_index)
                if meld.get("target") != pon.get("target"):
                    _fail(label, "加杠编码的副露来源与原来的碰不一致", action_index)
                _remove_tile(hands[actor], meld["pai"], label, action_index, "加杠")
                pons[actor].pop(family, None)
            events.append(meld)
            reveal_kan_dora()
            continue

        declares_riichi = isinstance(outgoing, str) and outgoing.startswith("r")
        raw_discard = outgoing[1:] if declares_riichi else outgoing
        if isinstance(raw_discard, str) and raw_discard.isdigit():
            raw_discard = int(raw_discard)
        if raw_discard == 60:
            tile = last_drawn[actor]
            if tile is None:
                _fail(label, "没有摸牌却标记为摸切", action_index)
            tsumogiri = True
        elif isinstance(raw_discard, int) and raw_discard != 0:
            tile = _tile_from_tenhou(raw_discard, label, action_index)
            tsumogiri = False
        else:
            _fail(label, f"无法识别出牌数据 {outgoing!r}", action_index)
        if riichi[actor] and not tsumogiri:
            _fail(label, "立直后出现了手切", action_index)
        if declares_riichi:
            if riichi[actor]:
                _fail(label, "同一玩家重复立直", action_index)
            if open_hand[actor]:
                _fail(label, "副露后不能立直", action_index)
            if running_scores[actor] < 1000:
                _fail(label, "分数不足 1000 点，不能立直", action_index)
            events.append({"type": "reach", "actor": actor})
        _remove_tile(hands[actor], tile, label, action_index, "出牌")
        discard = {"type": "dahai", "actor": actor, "pai": tile, "tsumogiri": tsumogiri}
        events.append(discard)
        last_discard = discard
        last_drawn[actor] = None

        caller = None
        for candidate in ((actor + 1) % 4, (actor + 2) % 4, (actor + 3) % 4):
            candidate_player = players[candidate]
            if candidate_player["in"] >= len(candidate_player["incoming"]):
                continue
            candidate_value = candidate_player["incoming"][candidate_player["in"]]
            if not isinstance(candidate_value, str):
                continue
            candidate_meld = _parse_meld(candidate_value, candidate, label, action_index + 1)
            if candidate_meld["type"] in ("chi", "pon", "daiminkan") and candidate_meld["target"] == actor and _tile_family(candidate_meld["pai"]) == _tile_family(tile):
                if caller is not None:
                    _fail(label, "同一张弃牌出现了多个副露", action_index)
                caller = candidate

        ron_here = any(win["target"] == actor for win in wins) and player["out"] == len(player["outgoing"])
        if declares_riichi and caller is None and not ron_here:
            events.append({"type": "reach_accepted", "actor": actor})
            riichi[actor] = True
            running_scores[actor] -= 1000
        actor = caller if caller is not None else (actor + 1) % 4
    else:
        _fail(label, "动作序列没有正常结束")

    for seat, player in enumerate(players):
        if player["in"] != len(player["incoming"]) or player["out"] != len(player["outgoing"]):
            _fail(label, f"第 {seat + 1} 家仍有无法接入正常巡序的摸牌或出牌数据", action_index + 1)

    ura_markers = [_tile_from_tenhou(value, label) for value in round_data[3]]
    if end_kind == "和了":
        for win in wins:
            event = {
                "type": "hora", "actor": win["actor"], "target": win["target"],
                "deltas": win["deltas"], "ura_markers": ura_markers,
            }
            emit(event)
    elif end_kind != "不明":
        emit({"type": "ryukyoku", "deltas": list(round_data[16][1]) if len(round_data[16]) > 1 else [0, 0, 0, 0], "reasonLabel": result_label})
    events.append({"type": "end_kyoku"})
    return events, copy.deepcopy(round_data[16])


def decode_custom_tenhou_log(document: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], List[List[Any]]]:
    rounds = document.get("log") or []
    events: List[Dict[str, Any]] = [{"type": "start_game", "names": copy.deepcopy(document["name"])}]
    settlements: List[List[Any]] = []
    previous: Tuple[int, int] | None = None
    seen: set[Tuple[int, int]] = set()
    for index, round_data in enumerate(rounds, 1):
        if not isinstance(round_data, list) or not round_data or not isinstance(round_data[0], list) or len(round_data[0]) < 2:
            raise ValueError(f"第 {index} 个小局缺少局数信息。")
        round_events, settlement = _decode_round(round_data, index)
        identity = (round_data[0][0], round_data[0][1])
        if identity in seen:
            raise ValueError(f"{_round_label(*identity)}重复出现。")
        if previous is not None and (identity[0] < previous[0] or (identity[0] == previous[0] and identity[1] <= previous[1])):
            raise ValueError(f"{_round_label(*identity)}的顺序早于前一个小局。")
        seen.add(identity)
        previous = identity
        events.extend(round_events)
        settlements.append(settlement)
    return events, settlements


def build_custom_tenhou_game(document: Dict[str, Any], game_id: str, created_at: str) -> Tuple[Dict[str, Any], int]:
    events, settlements = decode_custom_tenhou_log(document)
    first_header = document["log"][0][0]
    controlled_seat = int(first_header[0]) % 4
    report = {
        "player_id": controlled_seat,
        "game_length": "Hanchan" if any(int(round_data[0][0]) >= 4 for round_data in document["log"]) else "Tonpuusen",
        "mjai_log": events,
        "split_logs": [{"log": [[round_data[0], settlement]]} for round_data, settlement in zip(document["log"], settlements)],
    }
    game, _ = build_mortal_report_game(report, "", game_id, created_at)
    game["metadata"].update({
        "label": f"tenhou_{game_id.removeprefix('game_')}",
        "source": "tenhou-custom",
        "sourceUrl": "",
        "readOnly": True,
        "readOnlyReason": "missing-complete-wall",
        "playerNames": copy.deepcopy(document["name"]),
        "customTenhou": {
            key: copy.deepcopy(document[key])
            for key in ("rule", "title", "name", "ref", "ver") if key in document
        },
    })
    return game, controlled_seat


def _node_branch(game: Dict[str, Any]) -> List[Dict[str, Any]]:
    nodes = game.get("nodes") or {}
    current_id = game.get("currentNodeId")
    if current_id not in nodes:
        raise ValueError("当前牌谱没有可以导出的节点。")
    reverse_path = []
    cursor = current_id
    while cursor in nodes:
        reverse_path.append(cursor)
        cursor = nodes[cursor].get("parentId")
        if cursor is None:
            break
    path = list(reversed(reverse_path))
    cursor = current_id
    visited = set(path)
    while cursor in nodes:
        node = nodes[cursor]
        child = node.get("mainChildId")
        if child not in nodes:
            children = [child_id for child_id in node.get("children") or [] if child_id in nodes]
            child = children[0] if children else None
        if not child or child in visited:
            break
        path.append(child)
        visited.add(child)
        cursor = child
    return [nodes[node_id] for node_id in path]


def _meld_to_tenhou(action: Dict[str, Any]) -> str:
    action_type = action.get("type")
    actor = int(action.get("actor", 0))
    target = int(action.get("target", action.get("from", actor)))
    called = _tile_to_tenhou(action.get("pai")) if action.get("pai") else None
    consumed = [_tile_to_tenhou(tile) for tile in action.get("consumed") or []]
    direction = (target - actor) % 4
    if action_type == "chi" and called is not None and len(consumed) == 2:
        return f"c{called:02d}{consumed[0]:02d}{consumed[1]:02d}"
    if action_type == "pon" and called is not None and len(consumed) == 2:
        own = sorted(consumed)
        return {
            1: f"{own[0]:02d}{own[1]:02d}p{called:02d}",
            2: f"{own[0]:02d}p{called:02d}{own[1]:02d}",
            3: f"p{called:02d}{own[0]:02d}{own[1]:02d}",
        }[direction]
    if action_type == "daiminkan" and called is not None and len(consumed) == 3:
        own = sorted(consumed)
        return {
            1: f"{own[0]:02d}{own[1]:02d}{own[2]:02d}m{called:02d}",
            2: f"{own[0]:02d}m{called:02d}{own[1]:02d}{own[2]:02d}",
            3: f"m{called:02d}{own[0]:02d}{own[1]:02d}{own[2]:02d}",
        }[direction]
    if action_type == "ankan" and len(consumed) == 4:
        own = sorted(consumed)
        return f"{own[0]:02d}{own[1]:02d}{own[2]:02d}a{own[3]:02d}"
    if action_type == "kakan" and called is not None and len(consumed) >= 3:
        own_all = [_tile_to_tenhou(tile) for tile in action.get("consumed") or []]
        family = _tile_family(str(action.get("pai") or ""))
        called_original = next((tile for tile in own_all if _tile_family(_tile_from_tenhou(tile, "导出")) == family), own_all[-1])
        own = sorted(own_all[:2])
        added = called
        return {
            1: f"{own[0]:02d}{own[1]:02d}k{added:02d}{called_original:02d}",
            2: f"{own[0]:02d}k{added:02d}{called_original:02d}{own[1]:02d}",
            3: f"k{added:02d}{called_original:02d}{own[0]:02d}{own[1]:02d}",
        }[direction]
    raise ValueError(f"无法导出不完整的 {action_type} 动作。")


def _export_end_info(group: List[Dict[str, Any]]) -> List[Any]:
    result_node = next((node for node in reversed(group) if (node.get("action") or {}).get("type") == "round_result"), None)
    if result_node is None:
        return ["不明"]
    result = ((result_node.get("snapshot") or {}).get("lastAction") or {}).get("result") or {}
    event_type = result.get("eventType")
    event_data = result.get("eventData") or {}
    if event_type == "hora":
        hora_events = event_data.get("horaEvents") if isinstance(event_data.get("horaEvents"), list) else [event_data]
        output: List[Any] = ["和了"]
        for event in hora_events:
            actor = int(event.get("actor", 0))
            target = int(event.get("target", actor))
            deltas = event.get("deltas") or result.get("deltas") or [0, 0, 0, 0]
            score_text = str(event.get("scoreText") or event.get("scoreLabel") or "0点")
            detail = [actor, target, int(event.get("liablePlayer", actor)), score_text]
            output.extend([list(deltas), detail])
        return output
    label = str(event_data.get("reasonLabel") or "流局")
    deltas = event_data.get("deltas") or [0, 0, 0, 0]
    return [label, list(deltas)] if label in ("流局", "流し満貫") else [label]


def _export_round(group: List[Dict[str, Any]]) -> List[Any]:
    start_node = next((node for node in group if (node.get("action") or {}).get("type") == "start_kyoku"), group[0])
    start = start_node.get("snapshot") or {}
    initial_hands = start.get("initialHands") or [[], [], [], []]
    if len(initial_hands) != 4 or any(len(hand) != 13 for hand in initial_hands):
        raise ValueError(f"{_round_label(int(start.get('roundIndex', 0)), int(start.get('honba', 0)))}的起手牌无法导出。")
    incoming: List[List[Any]] = [[], [], [], []]
    outgoing: List[List[Any]] = [[], [], [], []]
    dora = [_tile_to_tenhou(tile) for tile in start.get("doraIndicators") or []]
    ura: List[int] = []
    initial_history = start.get("actionHistory") or []
    first_action = next((node.get("action") or {} for node in group if (node.get("action") or {}).get("type") not in ("start_kyoku", "round_result", "match_end")), {})
    if first_action.get("type") != "tsumo":
        initial_draw = next((event for event in initial_history if event.get("type") == "tsumo"), None)
        if initial_draw:
            incoming[int(initial_draw.get("actor", start.get("dealer", 0)))].append(_tile_to_tenhou(initial_draw.get("pai")))

    pending_reach = [False, False, False, False]
    exported_pons: List[Dict[str, Dict[str, Any]]] = [{}, {}, {}, {}]
    for node in group:
        if node.get("type") == "decision":
            continue
        action = node.get("action") or {}
        action_type = action.get("type")
        actor = int(action.get("actor", 0)) if action.get("actor") is not None else 0
        if action_type == "tsumo":
            incoming[actor].append(_tile_to_tenhou(action.get("pai")))
        elif action_type == "reach":
            pending_reach[actor] = True
        elif action_type == "dahai":
            value: Any = 60 if action.get("tsumogiri") else _tile_to_tenhou(action.get("pai"))
            if pending_reach[actor] or action.get("riichi"):
                value = f"r{value}"
                pending_reach[actor] = False
            outgoing[actor].append(value)
        elif action_type in ("chi", "pon"):
            incoming[actor].append(_meld_to_tenhou(action))
            if action_type == "pon":
                exported_pons[actor][_tile_family(str(action.get("pai") or ""))] = copy.deepcopy(action)
        elif action_type == "daiminkan":
            incoming[actor].append(_meld_to_tenhou(action))
            outgoing[actor].append(0)
        elif action_type in ("ankan", "kakan"):
            export_action = action
            if action_type == "kakan" and (
                not action.get("consumed")
                or (action.get("target") is None and action.get("from") is None)
            ):
                pon = exported_pons[actor].get(_tile_family(str(action.get("pai") or "")))
                if pon is None:
                    raise ValueError(f"无法导出没有对应碰的加杠：{action.get('pai') or '未知牌'}")
                export_action = {
                    **action,
                    "target": pon.get("target", pon.get("from")),
                    "consumed": list(action.get("consumed") or []) or list(pon.get("consumed") or []) + [pon.get("pai")],
                }
            outgoing[actor].append(_meld_to_tenhou(export_action))
        elif action_type == "dora":
            marker = action.get("dora_marker") or action.get("doraMarker")
            if marker:
                code = _tile_to_tenhou(marker)
                if code not in dora:
                    dora.append(code)
        elif action_type == "hora":
            markers = action.get("ura_markers") or action.get("uraMarkers") or []
            if markers:
                ura = [_tile_to_tenhou(tile) for tile in markers]

    output: List[Any] = [
        [int(start.get("roundIndex", 0)), int(start.get("honba", 0)), int(start.get("startKyotaku", start.get("kyotaku", 0)))],
        list(start.get("startScores") or start.get("scores") or [25000] * 4),
        dora[:5], ura[:5],
    ]
    for seat in range(4):
        output.extend([[_tile_to_tenhou(tile) for tile in initial_hands[seat]], incoming[seat], outgoing[seat]])
    output.append(_export_end_info(group))
    return output


def export_custom_tenhou(game: Dict[str, Any]) -> Dict[str, str]:
    branch = _node_branch(game)
    groups: List[List[Dict[str, Any]]] = []
    if any((node.get("action") or {}).get("type") == "start_kyoku" for node in branch):
        for node in branch:
            if (node.get("action") or {}).get("type") == "start_kyoku":
                groups.append([])
            if groups:
                groups[-1].append(node)
    elif branch:
        groups = [branch]
    if not groups:
        raise ValueError("当前分支没有可以导出的小局。")
    rounds = [_export_round(group) for group in groups]
    metadata = (game.get("metadata") or {}).get("customTenhou") or {}
    names = list((game.get("metadata") or {}).get("playerNames") or metadata.get("name") or ["Player 1", "Player 2", "Player 3", "Player 4"])
    root = {
        "rule": copy.deepcopy(metadata.get("rule") or {"aka": 1, "disp": "4-Player South"}),
        "title": copy.deepcopy(metadata.get("title") or ["Riichi Mahjong Studio", ""]),
        "log": rounds,
        "name": names,
    }
    for key in ("ref", "ver"):
        if key in metadata:
            root[key] = copy.deepcopy(metadata[key])
    compact = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    current_snapshot = game["nodes"][game["currentNodeId"]].get("snapshot") or {}
    current_identity = (int(current_snapshot.get("roundIndex", 0)), int(current_snapshot.get("honba", 0)))
    current_round = next((round_data for round_data in rounds if tuple(round_data[0][:2]) == current_identity), rounds[-1])
    current_root = copy.deepcopy(root)
    current_root["log"] = [current_round]
    naga_lines = []
    for round_data in rounds:
        naga_root = copy.deepcopy(root)
        naga_root["log"] = [round_data]
        naga_lines.append("https://tenhou.net/6/#json=" + compact(naga_root))
    return {
        "tenhou": compact(current_root),
        "mortal": compact(root),
        "naga": "\n".join(naga_lines),
    }
