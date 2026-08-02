import sys
from pathlib import Path
from typing import Any, Dict, List

from mjai_stream import normalize_tile_for_mjai


def get_project_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


VENDOR_DIR = get_project_root() / "python" / "vendor"
if str(VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(VENDOR_DIR))

from mahjong.constants import EAST, NORTH, SOUTH, WEST
from mahjong.hand_calculating.hand import HandCalculator
from mahjong.hand_calculating.hand_config import HandConfig, OptionalRules
from mahjong.meld import Meld
from rule_kernel import (
    build_player_state,
    can_ankan,
    can_declare_riichi,
    can_declare_ron,
    can_declare_ryukyoku,
    can_declare_tsumo,
    compute_shanten,
    get_ankan_candidates,
    get_valid_riichi_discards,
)



TERMINAL_HONOR_TILES = {
    "1m",
    "9m",
    "1p",
    "9p",
    "1s",
    "9s",
    "E",
    "S",
    "W",
    "N",
    "P",
    "F",
    "C",
}
WIND_34_BY_LABEL = {
    "E": EAST,
    "S": SOUTH,
    "W": WEST,
    "N": NORTH,
}
TILE_BASE_136 = {
    "1m": 0, "2m": 4, "3m": 8, "4m": 12, "5m": 16, "6m": 20, "7m": 24, "8m": 28, "9m": 32,
    "1p": 36, "2p": 40, "3p": 44, "4p": 48, "5p": 52, "6p": 56, "7p": 60, "8p": 64, "9p": 68,
    "1s": 72, "2s": 76, "3s": 80, "4s": 84, "5s": 88, "6s": 92, "7s": 96, "8s": 100, "9s": 104,
    "E": 108, "S": 112, "W": 116, "N": 120, "P": 124, "F": 128, "C": 132,
}


def count_yaochu_kinds(tiles: List[str]) -> int:
    normalized = {normalize_tile_for_mjai(tile) for tile in tiles}
    return len(normalized & TERMINAL_HONOR_TILES)


class Tile136Allocator:
    def __init__(self) -> None:
        self.next_offsets: Dict[str, int] = {}

    def alloc(self, tile: str) -> int:
        normalized = normalize_tile_for_mjai(tile)
        if normalized not in TILE_BASE_136:
            raise ValueError(f"Unsupported tile for settlement: {tile}")

        if tile == "5mr":
            return 16
        if tile == "5pr":
            return 52
        if tile == "5sr":
            return 88

        base = TILE_BASE_136[normalized]
        used_offset = self.next_offsets.get(normalized, 0)
        candidate = base + used_offset
        if candidate in (16, 52, 88) and normalized in {"5m", "5p", "5s"}:
            used_offset += 1
            candidate = base + used_offset
        self.next_offsets[normalized] = used_offset + 1
        return candidate


def seat_to_player_wind(snapshot: Dict[str, Any], seat: int) -> int:
    dealer = int(snapshot.get("dealer", 0))
    rel = (seat - dealer) % 4
    return [EAST, SOUTH, WEST, NORTH][rel]


def build_meld_objects(snapshot: Dict[str, Any], seat: int, allocator: Tile136Allocator) -> List[Meld]:
    melds: List[Meld] = []
    for meld in snapshot.get("melds", [[], [], [], []])[seat]:
        meld_type = meld.get("type")
        if meld_type not in ("chi", "pon", "daiminkan", "ankan", "kakan"):
            continue
        consumed = [str(tile) for tile in meld.get("consumed", [])]
        called = str(meld.get("pai") or "")
        if meld_type == "ankan":
            tile_order = consumed[:]
        else:
            tile_order = consumed + ([called] if called else [])
        if meld_type == "chi":
            tile_order = sorted(tile_order, key=lambda tile: (normalize_tile_for_mjai(tile)[-1], int(normalize_tile_for_mjai(tile)[0])))
        meld_tiles = [allocator.alloc(tile) for tile in tile_order]
        meld_kind = Meld.CHI if meld_type == "chi" else (
            Meld.PON if meld_type == "pon" else (
                Meld.SHOUMINKAN if meld_type == "kakan" else Meld.KAN
            )
        )
        called_tile = meld_tiles[-1] if meld_type != "ankan" and meld_tiles else None
        melds.append(
            Meld(
                meld_type=meld_kind,
                tiles=meld_tiles,
                opened=meld_type != "ankan",
                called_tile=called_tile,
                who=seat,
                from_who=meld.get("from", meld.get("target")),
            )
        )
    return melds


def build_hand_tiles(snapshot: Dict[str, Any], seat: int, allocator: Tile136Allocator) -> List[int]:
    return [allocator.alloc(tile) for tile in snapshot.get("hands", [[], [], [], []])[seat]]


def collect_ura_indicators(snapshot: Dict[str, Any]) -> List[str]:
    indicators = snapshot.get("uraIndicators")
    if isinstance(indicators, list):
        return [str(tile) for tile in indicators[: len(snapshot.get("doraIndicators", []))]]
    return []


def compute_exhaustive_ryukyoku(snapshot: Dict[str, Any]) -> Dict[str, Any]:
    tenpai_seats = [seat for seat in range(4) if compute_shanten(snapshot, seat) == 0]
    can_renchan = snapshot["dealer"] in tenpai_seats
    deltas = [0, 0, 0, 0]

    plus, minus = {
        1: (3000, -1000),
        2: (1500, -1500),
        3: (1000, -3000),
    }.get(len(tenpai_seats), (0, 0))

    if plus > 0:
        deltas = [minus, minus, minus, minus]
        for seat in tenpai_seats:
            deltas[seat] = plus

    scores = [snapshot["scores"][seat] + deltas[seat] for seat in range(4)]
    return {
        "eventType": "ryukyoku",
        "reason": "exhaustive_draw",
        "deltas": deltas,
        "scores": scores,
        "canRenchan": can_renchan,
        "hasHora": False,
        "hasAbortiveRyukyoku": False,
        "kyotakuLeft": snapshot["kyotaku"],
        "tenpaiSeats": tenpai_seats,
    }


def compute_abortive_ryukyoku(snapshot: Dict[str, Any], reason: str) -> Dict[str, Any]:
    return {
        "eventType": "ryukyoku",
        "reason": reason,
        "reasonLabel": {
            "kyuushu_kyuuhai": "九种九牌",
            "suufon_renda": "四风连打",
            "suukantsu": "四杠散了",
            "suucha_riichi": "四家立直",
        }.get(reason, "流局"),
        "deltas": [0, 0, 0, 0],
        "scores": snapshot["scores"][:],
        "canRenchan": True,
        "hasHora": False,
        "hasAbortiveRyukyoku": True,
        "kyotakuLeft": snapshot["kyotaku"],
        "tenpaiSeats": [],
    }


def compute_hora_result(snapshot: Dict[str, Any], actor: int, target: int, win_tile: str, is_tsumo: bool) -> Dict[str, Any]:
    allocator = Tile136Allocator()
    melds = build_meld_objects(snapshot, actor, allocator)
    hand_tiles = build_hand_tiles(snapshot, actor, allocator)
    if is_tsumo:
        matching_index = next((index for index, tile in enumerate(snapshot.get("hands", [[], [], [], []])[actor]) if tile == win_tile), -1)
        if matching_index == -1:
            raise ValueError("Tsumo settlement could not find the winning tile in hand.")
        allocator = Tile136Allocator()
        melds = build_meld_objects(snapshot, actor, allocator)
        tiles = build_hand_tiles(snapshot, actor, allocator)
        win_tile_136 = next((tile_136 for tile_136 in tiles if tile_136 // 4 == TILE_BASE_136[normalize_tile_for_mjai(win_tile)] // 4), None)
        if win_tile_136 is None:
            raise ValueError("Tsumo settlement could not resolve a winning tile in 136 format.")
    else:
        win_tile_136 = allocator.alloc(win_tile)
        tiles = hand_tiles + [win_tile_136]
    dora_indicators = [allocator.alloc(str(tile)) for tile in snapshot.get("doraIndicators", [])]
    ura_indicators = [allocator.alloc(tile) for tile in collect_ura_indicators(snapshot)]

    last_action = (snapshot.get("actionHistory") or [{}])[-1]
    last_draw_source = str(last_action.get("source") or "wall") if last_action.get("type") == "tsumo" else "wall"
    is_rinshan = is_tsumo and last_draw_source == "rinshan"
    is_chankan = (not is_tsumo) and last_action.get("type") == "kakan"
    live_wall_empty = int(snapshot.get("drawIndex", 0)) >= len(snapshot.get("wall", []))
    riichi_accepted = bool((snapshot.get("riichiAccepted") or [False, False, False, False])[actor])
    ippatsu_eligible = bool((snapshot.get("ippatsuEligible") or [False, False, False, False])[actor])
    options = OptionalRules(
        has_open_tanyao=True,
        has_aka_dora=True,
        kiriage=True,
    )
    config = HandConfig(
        is_tsumo=is_tsumo,
        is_riichi=riichi_accepted,
        is_ippatsu=bool(riichi_accepted and ippatsu_eligible),
        is_rinshan=is_rinshan,
        is_chankan=is_chankan,
        is_haitei=bool(is_tsumo and live_wall_empty and not is_rinshan),
        is_houtei=bool((not is_tsumo) and live_wall_empty),
        player_wind=seat_to_player_wind(snapshot, actor),
        round_wind=WIND_34_BY_LABEL.get(str(snapshot.get("bakaze", "E")), EAST),
        tsumi_number=int(snapshot.get("honba", 0)),
        kyoutaku_number=int(snapshot.get("kyotaku", 0)),
        options=options,
    )

    all_tiles = list(tiles)
    for meld in melds:
        all_tiles.extend(meld.tiles)

    result = HandCalculator.estimate_hand_value(
        tiles=all_tiles,
        win_tile=win_tile_136,
        melds=melds,
        dora_indicators=dora_indicators,
        ura_dora_indicators=ura_indicators if riichi_accepted else None,
        config=config,
    )
    if result.error or not result.cost:
        raise ValueError(f"Failed to score hora: {result.error or 'missing cost'}")

    cost = result.cost
    deltas = [0, 0, 0, 0]
    if is_tsumo:
        if actor == snapshot["dealer"]:
            payment = int(cost["main"] + cost["main_bonus"])
            for seat in range(4):
                if seat == actor:
                    continue
                deltas[seat] -= payment
            deltas[actor] += payment * 3 + int(cost["kyoutaku_bonus"])
        else:
            dealer = int(snapshot["dealer"])
            dealer_payment = int(cost["main"] + cost["main_bonus"])
            other_payment = int(cost["additional"] + cost["additional_bonus"])
            for seat in range(4):
                if seat == actor:
                    continue
                deltas[seat] -= dealer_payment if seat == dealer else other_payment
            deltas[actor] += dealer_payment + other_payment * 2 + int(cost["kyoutaku_bonus"])
    else:
        payment = int(cost["main"] + cost["main_bonus"])
        deltas[target] -= payment
        deltas[actor] += payment + int(cost["kyoutaku_bonus"])

    yaku_details = []
    for yaku in result.yaku or []:
        yaku_han = yaku.han_open if result.is_open_hand else yaku.han_closed
        yaku_details.append({
            "name": str(yaku.name),
            "han": int(yaku_han or 0),
            "isYakuman": bool(yaku.is_yakuman),
        })

    scores = [snapshot["scores"][seat] + deltas[seat] for seat in range(4)]
    return {
        "eventType": "hora",
        "actor": actor,
        "target": target,
        "deltas": deltas,
        "scores": scores,
        "canRenchan": actor == snapshot["dealer"],
        "hasHora": True,
        "hasAbortiveRyukyoku": False,
        "kyotakuLeft": 0,
        "uraMarkers": collect_ura_indicators(snapshot) if riichi_accepted else [],
        "han": int(result.han or 0),
        "fu": int(result.fu or 0),
        "yaku": [yaku.name for yaku in (result.yaku or [])],
        "yakuDetails": yaku_details,
        "isOpenHand": bool(result.is_open_hand),
        "cost": dict(result.cost),
    }


def compute_hora_placeholder(snapshot: Dict[str, Any], actor: int, target: int) -> Dict[str, Any]:
    deltas = [0, 0, 0, 0]
    return {
        "eventType": "hora",
        "actor": actor,
        "target": target,
        "deltas": deltas,
        "scores": snapshot["scores"][:],
        "canRenchan": actor == snapshot["dealer"],
        "hasHora": True,
        "hasAbortiveRyukyoku": False,
        "kyotakuLeft": snapshot["kyotaku"],
        "uraMarkers": [],
    }
