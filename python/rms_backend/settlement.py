from typing import Any, Dict, List

from .mjai_stream import normalize_tile_for_mjai
from .rule_kernel import compute_shanten



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


def count_yaochu_kinds(tiles: List[str]) -> int:
    normalized = {normalize_tile_for_mjai(tile) for tile in tiles}
    return len(normalized & TERMINAL_HONOR_TILES)


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
