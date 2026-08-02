"""Host-owned rule queries built on the MIT-licensed mahjong package."""

from __future__ import annotations

import copy
import sys
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any


def _project_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


VENDOR_DIR = _project_root() / "python" / "vendor"
if str(VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(VENDOR_DIR))

from mahjong.agari import Agari  # noqa: E402
from mahjong.shanten import Shanten  # noqa: E402


TILE_INDEX_TO_FAMILY = [
    "1m", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "9m",
    "1p", "2p", "3p", "4p", "5p", "6p", "7p", "8p", "9p",
    "1s", "2s", "3s", "4s", "5s", "6s", "7s", "8s", "9s",
    "E", "S", "W", "N", "P", "F", "C",
]
TILE_TO_INDEX = {tile: index for index, tile in enumerate(TILE_INDEX_TO_FAMILY)}
TERMINAL_HONOR_INDICES = frozenset(
    {0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33}
)


def _family(tile: Any) -> str:
    value = str(tile or "")
    return value.replace("5mr", "5m").replace("5pr", "5p").replace("5sr", "5s")


def _tile_index(tile: Any) -> int:
    family = _family(tile)
    if family not in TILE_TO_INDEX:
        raise ValueError(f"unknown tile: {tile}")
    return TILE_TO_INDEX[family]


def _remove_tile(hand: list[str], tile: Any) -> None:
    value = str(tile or "")
    try:
        hand.remove(value)
        return
    except ValueError:
        pass
    family = _family(value)
    index = next((i for i, current in enumerate(hand) if _family(current) == family), None)
    if index is not None:
        hand.pop(index)


def _current_hand(snapshot: dict[str, Any], seat: int) -> list[str]:
    hands = snapshot.get("hands")
    if isinstance(hands, list) and seat < len(hands) and isinstance(hands[seat], list):
        return [str(tile) for tile in hands[seat] if str(tile) != "?"]

    initial = snapshot.get("initialHands") or [[], [], [], []]
    hand = [str(tile) for tile in (initial[seat] if seat < len(initial) else []) if str(tile) != "?"]
    for action in snapshot.get("actionHistory") or []:
        if not isinstance(action, dict) or int(action.get("actor", -1)) != seat:
            continue
        action_type = str(action.get("type") or "")
        if action_type == "tsumo" and str(action.get("pai") or "") != "?":
            hand.append(str(action["pai"]))
        elif action_type == "dahai":
            _remove_tile(hand, action.get("pai"))
        elif action_type in ("chi", "pon", "daiminkan", "ankan"):
            for tile in action.get("consumed") or []:
                _remove_tile(hand, tile)
        elif action_type == "kakan":
            _remove_tile(hand, action.get("pai"))
    return hand


def _hand34(tiles: list[str]) -> list[int]:
    result = [0] * 34
    for tile in tiles:
        if tile != "?":
            result[_tile_index(tile)] += 1
    return result


def _wall_remaining(snapshot: dict[str, Any]) -> int:
    wall = snapshot.get("wall")
    if isinstance(wall, (list, tuple)):
        return max(0, len(wall) - int(snapshot.get("drawIndex", 0)))
    return max(0, int(snapshot.get("wallRemaining", 0)))


def _latest_action(snapshot: dict[str, Any]) -> dict[str, Any]:
    history = snapshot.get("actionHistory")
    if isinstance(history, list) and history and isinstance(history[-1], dict):
        return history[-1]
    action = snapshot.get("lastAction")
    return action if isinstance(action, dict) else {}


def _is_own_draw(snapshot: dict[str, Any], seat: int) -> bool:
    action = _latest_action(snapshot)
    return (
        snapshot.get("phase") in ("discard", "draw_or_discard")
        and int(snapshot.get("currentActor", -1)) == seat
        and action.get("type") == "tsumo"
        and int(action.get("actor", -1)) == seat
    )


def _is_menzen(snapshot: dict[str, Any], seat: int) -> bool:
    melds = (snapshot.get("melds") or [[], [], [], []])[seat]
    return not any(meld.get("type") in ("chi", "pon", "daiminkan", "kakan") for meld in melds)


@dataclass
class RuleState:
    snapshot: dict[str, Any]
    seat: int
    hand: list[str]
    game: SimpleNamespace


def build_player_state(snapshot: dict[str, Any], seat: int) -> RuleState:
    seat = int(seat)
    hand = _current_hand(snapshot, seat)
    latest = _latest_action(snapshot)
    game = SimpleNamespace(
        wall_remaining=_wall_remaining(snapshot),
        is_menzen=[_is_menzen(snapshot, current) for current in range(4)],
        riichi_accepted=list(snapshot.get("riichiAccepted") or [False] * 4),
        last_tsumo_tile=(
            _tile_index(latest.get("pai"))
            if latest.get("type") == "tsumo" and int(latest.get("actor", -1)) == seat
            else None
        ),
    )
    return RuleState(snapshot=snapshot, seat=seat, hand=hand, game=game)


def _coerce_state(snapshot: dict[str, Any], seat: int, state: RuleState | None) -> RuleState:
    if isinstance(state, RuleState) and state.snapshot is snapshot and state.seat == seat:
        return state
    return build_player_state(snapshot, seat)


def compute_shanten(snapshot: dict[str, Any], seat: int, state: RuleState | None = None) -> int:
    rule_state = _coerce_state(snapshot, int(seat), state)
    hand = list(rule_state.hand)
    if _is_own_draw(snapshot, int(seat)) and len(hand) % 3 == 2:
        _remove_tile(hand, _latest_action(snapshot).get("pai"))
    if not hand:
        return 6
    return max(0, int(Shanten.calculate_shanten(_hand34(hand))))


def get_valid_riichi_discards(
    snapshot: dict[str, Any],
    seat: int,
    state: RuleState | None = None,
) -> list[str]:
    hand = list(_coerce_state(snapshot, int(seat), state).hand)
    if len(hand) % 3 != 2:
        return []
    result: list[str] = []
    for tile in TILE_INDEX_TO_FAMILY:
        if tile not in {_family(value) for value in hand}:
            continue
        candidate = list(hand)
        _remove_tile(candidate, tile)
        if Shanten.calculate_shanten(_hand34(candidate)) == 0:
            result.append(tile)
    return result


def can_declare_riichi(snapshot: dict[str, Any], seat: int, state: RuleState | None = None) -> bool:
    seat = int(seat)
    if not _is_own_draw(snapshot, seat) or int(snapshot.get("scores", [0] * 4)[seat]) < 1000:
        return False
    if (snapshot.get("riichiAccepted") or [False] * 4)[seat] or _wall_remaining(snapshot) < 4:
        return False
    return _is_menzen(snapshot, seat) and bool(get_valid_riichi_discards(snapshot, seat, state))


def can_declare_ryukyoku(snapshot: dict[str, Any], seat: int, state: RuleState | None = None) -> bool:
    seat = int(seat)
    rivers = snapshot.get("rivers") or [[], [], [], []]
    melds = snapshot.get("melds") or [[], [], [], []]
    if not _is_own_draw(snapshot, seat) or rivers[seat] or any(melds):
        return False
    hand = _hand34(_coerce_state(snapshot, seat, state).hand)
    return sum(1 for index in TERMINAL_HONOR_INDICES if hand[index]) >= 9


def _working_snapshot(snapshot: dict[str, Any], seat: int, hand: list[str]) -> dict[str, Any]:
    working = copy.deepcopy(snapshot)
    hands = working.get("hands")
    if not isinstance(hands, list) or len(hands) != 4:
        hands = [[], [], [], []]
    hands[seat] = list(hand)
    working["hands"] = hands
    return working


def can_declare_tsumo(snapshot: dict[str, Any], seat: int, state: RuleState | None = None) -> bool:
    seat = int(seat)
    if not _is_own_draw(snapshot, seat):
        return False
    hand = list(_coerce_state(snapshot, seat, state).hand)
    if not Agari.is_agari(_hand34(hand)):
        return False
    win_tile = str(_latest_action(snapshot).get("pai") or "")
    try:
        from settlement import compute_hora_result
        compute_hora_result(_working_snapshot(snapshot, seat, hand), seat, seat, win_tile, True)
        return True
    except (ImportError, ValueError, KeyError, IndexError):
        return False


def _reaction_tile(snapshot: dict[str, Any]) -> tuple[str, int | None]:
    pending = snapshot.get("pendingKan") if snapshot.get("phase") == "kan_reaction_window" else None
    if isinstance(pending, dict):
        return str(pending.get("pai") or ""), pending.get("actor")
    reaction = snapshot.get("reactionWindow")
    discard = reaction.get("discard") if isinstance(reaction, dict) else None
    if isinstance(discard, dict):
        return str(discard.get("pai") or ""), discard.get("actor")
    action = _latest_action(snapshot)
    return str(action.get("pai") or ""), action.get("actor")


def _waits(hand: list[str]) -> set[str]:
    waits = set()
    counts = _hand34(hand)
    for tile, index in TILE_TO_INDEX.items():
        if counts[index] >= 4:
            continue
        candidate = list(counts)
        candidate[index] += 1
        if Agari.is_agari(candidate):
            waits.add(tile)
    return waits


def _has_temporary_furiten(snapshot: dict[str, Any], seat: int, waits: set[str]) -> bool:
    history = [action for action in (snapshot.get("actionHistory") or []) if isinstance(action, dict)]
    segment_start = 0
    for index, action in enumerate(history):
        if (
            int(action.get("actor", -1)) == seat
            and action.get("type") in ("tsumo", "chi", "pon", "daiminkan", "ankan", "kakan")
        ):
            segment_start = index + 1
    for index, action in enumerate(history[segment_start:-1], start=segment_start):
        if action.get("type") != "dahai" or int(action.get("actor", -1)) == seat:
            continue
        if _family(action.get("pai")) not in waits:
            continue
        following = history[index + 1] if index + 1 < len(history) else {}
        claimed = (
            following.get("type") == "hora"
            and int(following.get("actor", -1)) == seat
            and int(following.get("target", -2)) == int(action.get("actor", -1))
        )
        if not claimed:
            return True
    return False


def can_declare_ron(snapshot: dict[str, Any], seat: int, state: RuleState | None = None) -> bool:
    seat = int(seat)
    if snapshot.get("phase") not in ("reaction_window", "kan_reaction_window"):
        return False
    tile, actor = _reaction_tile(snapshot)
    if not tile or tile == "?" or actor is None or int(actor) == seat:
        return False
    hand = list(_coerce_state(snapshot, seat, state).hand)
    waits = _waits(hand)
    if _family(tile) not in waits:
        return False
    own_discards = {_family(value) for value in (snapshot.get("rivers") or [[], [], [], []])[seat]}
    if waits & own_discards or _has_temporary_furiten(snapshot, seat, waits):
        return False
    hand.append(tile)
    try:
        from settlement import compute_hora_result
        compute_hora_result(_working_snapshot(snapshot, seat, hand[:-1]), seat, int(actor), tile, False)
        return True
    except (ImportError, ValueError, KeyError, IndexError):
        return False


def get_ankan_candidates(snapshot: dict[str, Any], seat: int, state: RuleState | None = None) -> list[str]:
    seat = int(seat)
    if not _is_own_draw(snapshot, seat) or _wall_remaining(snapshot) == 0:
        return []
    melds = snapshot.get("melds") or [[], [], [], []]
    kans = sum(meld.get("type") in ("daiminkan", "ankan", "kakan") for group in melds for meld in group)
    if kans >= 4:
        return []
    hand = list(_coerce_state(snapshot, seat, state).hand)
    counts = _hand34(hand)
    candidates = [TILE_INDEX_TO_FAMILY[index] for index, count in enumerate(counts) if count == 4]
    if not (snapshot.get("riichiAccepted") or [False] * 4)[seat]:
        return candidates
    drawn = _family(_latest_action(snapshot).get("pai"))
    if drawn not in candidates:
        return []
    before_draw = list(hand)
    _remove_tile(before_draw, drawn)
    after_kan = [tile for tile in hand if _family(tile) != drawn]
    return [drawn] if _waits(before_draw) == _waits(after_kan) else []


def can_ankan(snapshot: dict[str, Any], seat: int, state: RuleState | None = None) -> bool:
    return bool(get_ankan_candidates(snapshot, seat, state))
