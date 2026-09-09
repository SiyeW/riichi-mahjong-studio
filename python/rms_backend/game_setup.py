import copy
import random

from . import snapshot_state
from .analysis_cache import ANALYSIS_SOURCES_FIELD
from .match_progression import get_round_seed
from .service_helpers import (
    DORA_INDICATOR_POSITIONS,
    HONOR_TILES,
    RINSHAN_DRAW_POSITIONS,
    SUIT_TILES,
    URA_INDICATOR_POSITIONS,
    build_round_seed_stream,
    build_wall,
    sort_tiles,
)


def create_match_state(seed, match_id):
    randomizer = random.Random(seed)
    return {
        "matchId": str(match_id),
        "seed": seed,
        "matchType": "hanchan",
        "players": 4,
        "roundIndex": 0,
        "bakaze": "E",
        "kyoku": 1,
        "honba": 0,
        "kyotaku": 0,
        "dealer": 0,
        "scores": [25000, 25000, 25000, 25000],
        "westEntryEnabled": True,
        "westEntered": False,
        "maxBakaze": "W",
        "maxKyoku": 4,
        "ended": False,
        "inRenchan": False,
        "roundSeeds": build_round_seed_stream(randomizer),
    }


def create_initial_snapshot(match_state, full_wall=None):
    if full_wall is None:
        seed = get_round_seed(match_state, int(match_state.get("roundIndex", 0)))
        honba = int(match_state.get("honba", 0))
        if honba > 0:
            seed = seed + honba * 7919
        randomizer = random.Random(seed)
        full_wall = build_wall(randomizer)
    else:
        full_wall = [str(tile) for tile in full_wall]
    full_wall = tuple(full_wall)
    live_wall = full_wall[:122]
    rinshan_wall = tuple(full_wall[index] for index in RINSHAN_DRAW_POSITIONS)
    dora_indicator_stack = tuple(full_wall[index] for index in DORA_INDICATOR_POSITIONS)
    ura_indicator_stack = tuple(full_wall[index] for index in URA_INDICATOR_POSITIONS)
    initial_hands = [sort_tiles(live_wall[i * 13:(i + 1) * 13]) for i in range(4)]
    draw_index = 52
    dora_indicators = [dora_indicator_stack[0]]
    ura_indicators = [ura_indicator_stack[0]]
    dealer = int(match_state["dealer"])

    hands = copy.deepcopy(initial_hands)
    dealer_draw_tile = live_wall[draw_index]
    hands[dealer].append(dealer_draw_tile)
    hands[dealer] = sort_tiles(hands[dealer])
    draw_index += 1

    snapshot = {
        "matchState": copy.deepcopy(match_state),
        "initialHands": copy.deepcopy(initial_hands),
        "startScores": copy.deepcopy(match_state["scores"]),
        "startKyotaku": int(match_state["kyotaku"]),
        "fullWall": full_wall,
        "hands": copy.deepcopy(hands),
        "rivers": [[], [], [], []],
        "wall": live_wall,
        "rinshanWall": rinshan_wall,
        "drawIndex": draw_index,
        "dealer": dealer,
        "currentActor": dealer,
        "phase": "discard",
        "turn": 0,
        "doraIndicators": dora_indicators[:],
        "uraIndicators": ura_indicators[:],
        "doraIndicatorStack": dora_indicator_stack,
        "uraIndicatorStack": ura_indicator_stack,
        "bakaze": match_state["bakaze"],
        "kyoku": match_state["kyoku"],
        "honba": match_state["honba"],
        "kyotaku": match_state["kyotaku"],
        "scores": copy.deepcopy(match_state["scores"]),
        "roundIndex": match_state["roundIndex"],
        "westEntered": bool(match_state.get("westEntered", False)),
        "inRenchan": bool(match_state.get("inRenchan", False)),
        "lastAction": {
            "type": "tsumo",
            "actor": dealer,
            "pai": dealer_draw_tile,
        },
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
        "actionHistory": [
            {
                "type": "tsumo",
                "actor": dealer,
                "pai": dealer_draw_tile,
                "tsumogiri": False,
            }
        ],
    }
    snapshot_state.sync(snapshot)
    return snapshot


def create_empty_game(seed, game_id, match_state, *, created_at):
    root_snapshot = create_initial_snapshot(match_state)
    root_node_id = "n_root"
    start_kyoku_id = "n_1"
    nodes = {
        root_node_id: {
            "id": root_node_id,
            "type": "root",
            "parentId": None,
            "children": [start_kyoku_id],
            "mainChildId": start_kyoku_id,
            "action": None,
            "actor": None,
            "snapshot": root_snapshot,
            "analysisCache": {},
            "depth": 0,
        },
        start_kyoku_id: {
            "id": start_kyoku_id,
            "type": "action",
            "parentId": root_node_id,
            "children": [],
            "mainChildId": None,
            "action": {"type": "start_kyoku", "source": "system"},
            "actor": None,
            "snapshot": copy.deepcopy(root_snapshot),
            "analysisCache": {},
            "depth": 1,
        },
    }
    return {
        "gameId": game_id,
        "matchId": match_state["matchId"],
        "seed": seed,
        "createdAt": created_at,
        "metadata": {
            "label": match_state["matchId"],
            "source": "local-environment",
        },
        "matchConfig": {
            "matchType": match_state["matchType"],
            "players": match_state["players"],
            "westEntryEnabled": match_state["westEntryEnabled"],
            "maxBakaze": match_state["maxBakaze"],
            "maxKyoku": match_state["maxKyoku"],
        },
        "matchState": copy.deepcopy(match_state),
        "rootNodeId": root_node_id,
        "currentNodeId": start_kyoku_id,
        "mainLeafNodeId": start_kyoku_id,
        "nextNodeIndex": 2,
        "treeRevision": 1,
        "pendingReview": None,
        ANALYSIS_SOURCES_FIELD: {},
        "nodes": nodes,
    }


def validate_full_wall_tiles(tiles):
    if not isinstance(tiles, list) or len(tiles) != 136:
        raise ValueError("牌山必须正好有 136 张牌。")
    normalized = [str(tile) for tile in tiles]
    allowed = set(SUIT_TILES + HONOR_TILES + ["5m", "5p", "5s", "5mr", "5pr", "5sr"])
    invalid = [tile for tile in normalized if tile not in allowed]
    if invalid:
        raise ValueError(f"牌山中存在非法牌张：{invalid[0]}")
    counts = {}
    for tile in normalized:
        counts[tile] = counts.get(tile, 0) + 1
    for tile in SUIT_TILES + HONOR_TILES:
        if counts.get(tile, 0) != 4:
            raise ValueError(f"{tile} 的数量必须是 4。")
    for tile in ("5mr", "5pr", "5sr"):
        if counts.get(tile, 0) != 1:
            raise ValueError(f"{tile} 的数量必须是 1。")
    for tile in ("5m", "5p", "5s"):
        if counts.get(tile, 0) != 3:
            raise ValueError(f"{tile} 的数量必须是 3。")
    return normalized
