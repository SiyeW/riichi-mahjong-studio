"""Compact and restore the persisted game-record representation."""

from __future__ import annotations

import copy
import json

from service_helpers import (
    DORA_INDICATOR_POSITIONS,
    RINSHAN_DRAW_POSITIONS,
    URA_INDICATOR_POSITIONS,
    now_iso,
)

OPPONENT_ANALYSIS_CACHE_FIELD = "opponentAnalysisCache"
_ROUND_WALL_STORAGE_FIELD = "roundWallStorage"
_SNAPSHOT_WALL_STATE_FIELD = "wallState"
_ROUND_WALL_LAYOUT_VERSION = 2
_ROUND_STATE_STORAGE_FIELD = "roundStateStorage"
_SNAPSHOT_ROUND_STATE_FIELD = "roundStateRef"
_ROUND_STATE_LAYOUT_VERSION = 1
RECORD_FORMAT_VERSION = 3
_ROUND_STATIC_FIELDS = (
    "initialHands",
    "startScores",
    "startKyotaku",
)
_TRANSIENT_ACTION_META_FIELDS = (
    "engineFingerprint",
    "error",
    "skip_reason",
    "thinking_time_s",
)
_LEGACY_RINSHAN_DRAW_POSITIONS = (134, 135, 132, 133)
_LEGACY_DORA_INDICATOR_POSITIONS = (130, 128, 126, 124, 122)
_LEGACY_URA_INDICATOR_POSITIONS = (131, 129, 127, 125, 123)
_STATIC_WALL_FIELDS = (
    "fullWall",
    "wall",
    "rinshanWall",
    "doraIndicatorStack",
    "uraIndicatorStack",
)


def _convert_legacy_wall_layout(full_wall):
    if len(full_wall) != 136:
        return tuple(full_wall)
    source = tuple(full_wall)
    converted = list(source)
    for old_positions, new_positions in (
        (_LEGACY_RINSHAN_DRAW_POSITIONS, RINSHAN_DRAW_POSITIONS),
        (_LEGACY_DORA_INDICATOR_POSITIONS, DORA_INDICATOR_POSITIONS),
        (_LEGACY_URA_INDICATOR_POSITIONS, URA_INDICATOR_POSITIONS),
    ):
        for old_index, new_index in zip(old_positions, new_positions):
            converted[new_index] = source[old_index]
    return tuple(converted)


def _compact_round_walls_for_record(game):
    if not isinstance(game, dict):
        return game
    walls = {}
    ids_by_wall = {}

    for node in (game.get("nodes") or {}).values():
        snapshot = node.get("snapshot") if isinstance(node, dict) else None
        if not isinstance(snapshot, dict):
            continue
        full_wall = tuple(snapshot.get("fullWall") or ())
        if len(full_wall) != 136:
            live_wall = tuple(snapshot.get("wall") or ())
            if not full_wall and all(str(tile) == "?" for tile in live_wall):
                snapshot[_SNAPSHOT_WALL_STATE_FIELD] = {
                    "incomplete": True,
                    "liveEnd": len(live_wall),
                }
                for field in _STATIC_WALL_FIELDS:
                    snapshot.pop(field, None)
                kyoku_state = snapshot.get("kyokuState")
                if isinstance(kyoku_state, dict):
                    for field in _STATIC_WALL_FIELDS:
                        kyoku_state.pop(field, None)
            continue

        wall_id = ids_by_wall.get(full_wall)
        if wall_id is None:
            wall_id = f"w{len(walls) + 1}"
            ids_by_wall[full_wall] = wall_id
            walls[wall_id] = list(full_wall)

        live_wall = snapshot.get("wall") or ()
        rinshan_remaining = snapshot.get("rinshanWall") or ()
        snapshot[_SNAPSHOT_WALL_STATE_FIELD] = {
            "ref": wall_id,
            "liveEnd": len(live_wall),
            "rinshanDrawn": max(0, 4 - len(rinshan_remaining)),
        }
        for field in _STATIC_WALL_FIELDS:
            snapshot.pop(field, None)
        kyoku_state = snapshot.get("kyokuState")
        if isinstance(kyoku_state, dict):
            for field in _STATIC_WALL_FIELDS:
                kyoku_state.pop(field, None)

    if walls:
        game[_ROUND_WALL_STORAGE_FIELD] = {
            "schemaVersion": _ROUND_WALL_LAYOUT_VERSION,
            "walls": walls,
        }
    else:
        game.pop(_ROUND_WALL_STORAGE_FIELD, None)
    return game


def _compact_round_states_for_record(game):
    if not isinstance(game, dict):
        return game
    states = {}
    ids_by_state = {}
    for node in (game.get("nodes") or {}).values():
        snapshot = node.get("snapshot") if isinstance(node, dict) else None
        if not isinstance(snapshot, dict):
            continue
        state = {
            field: copy.deepcopy(snapshot[field])
            for field in _ROUND_STATIC_FIELDS
            if field in snapshot
        }
        if not state:
            continue
        signature = json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        state_id = ids_by_state.get(signature)
        if state_id is None:
            state_id = f"r{len(states) + 1}"
            ids_by_state[signature] = state_id
            states[state_id] = state
        snapshot[_SNAPSHOT_ROUND_STATE_FIELD] = state_id
        for field in _ROUND_STATIC_FIELDS:
            snapshot.pop(field, None)

    if states:
        game[_ROUND_STATE_STORAGE_FIELD] = {
            "schemaVersion": _ROUND_STATE_LAYOUT_VERSION,
            "states": states,
        }
    else:
        game.pop(_ROUND_STATE_STORAGE_FIELD, None)
    return game


def _hydrate_round_states_from_record(game):
    if not isinstance(game, dict):
        return game
    storage = game.get(_ROUND_STATE_STORAGE_FIELD)
    if not isinstance(storage, dict):
        return game
    if int(storage.get("schemaVersion") or 0) != _ROUND_STATE_LAYOUT_VERSION:
        raise ValueError("不支持此轮次状态区版本。")
    states = storage.get("states")
    if not isinstance(states, dict):
        raise ValueError("存档的轮次状态区无效。")
    for node in (game.get("nodes") or {}).values():
        snapshot = node.get("snapshot") if isinstance(node, dict) else None
        if not isinstance(snapshot, dict):
            continue
        state_id = snapshot.pop(_SNAPSHOT_ROUND_STATE_FIELD, None)
        if state_id is None:
            continue
        state = states.get(str(state_id))
        if not isinstance(state, dict):
            raise ValueError(f"存档引用了不存在的轮次状态：{state_id}")
        for field in _ROUND_STATIC_FIELDS:
            if field in state:
                snapshot[field] = copy.deepcopy(state[field])
    game.pop(_ROUND_STATE_STORAGE_FIELD, None)
    return game


def _history_has_prefix(history, prefix):
    return len(history) >= len(prefix) and history[:len(prefix)] == prefix


def _compact_action_histories_for_record(game):
    nodes = game.get("nodes") if isinstance(game, dict) else None
    if not isinstance(nodes, dict):
        return game
    visited = set()

    def visit(node_id, parent_history):
        if node_id in visited:
            return
        node = nodes.get(node_id)
        if not isinstance(node, dict):
            return
        visited.add(node_id)
        snapshot = node.get("snapshot")
        history = list(snapshot.get("actionHistory") or ()) if isinstance(snapshot, dict) else []
        resets = bool(parent_history) and not _history_has_prefix(history, parent_history)
        delta = history if resets else history[len(parent_history):]
        if isinstance(snapshot, dict):
            snapshot.pop("actionHistory", None)
            if delta:
                snapshot["actionHistoryDelta"] = delta
            else:
                snapshot.pop("actionHistoryDelta", None)
            if resets:
                snapshot["actionHistoryReset"] = True
            else:
                snapshot.pop("actionHistoryReset", None)
        for child_id in node.get("children") or ():
            visit(str(child_id), history)

    root_id = str(game.get("rootNodeId") or "")
    if root_id in nodes:
        visit(root_id, [])
    for node_id in nodes:
        if node_id not in visited:
            visit(node_id, [])
    return game


def _hydrate_action_histories_from_record(game):
    nodes = game.get("nodes") if isinstance(game, dict) else None
    if not isinstance(nodes, dict):
        return game
    visited = set()

    def visit(node_id, parent_history, active):
        if node_id in active:
            raise ValueError("存档的节点树包含循环引用。")
        if node_id in visited:
            return
        node = nodes.get(node_id)
        if not isinstance(node, dict):
            raise ValueError(f"存档引用了不存在的节点：{node_id}")
        active.add(node_id)
        snapshot = node.get("snapshot")
        if not isinstance(snapshot, dict):
            raise ValueError(f"节点缺少局面状态：{node_id}")
        delta = list(snapshot.pop("actionHistoryDelta", []) or ())
        resets = bool(snapshot.pop("actionHistoryReset", False))
        history = delta if resets else list(parent_history) + delta
        snapshot["actionHistory"] = history
        visited.add(node_id)
        for child_id in node.get("children") or ():
            visit(str(child_id), history, active)
        active.remove(node_id)

    root_id = str(game.get("rootNodeId") or "")
    if root_id in nodes:
        visit(root_id, [], set())
    for node_id in nodes:
        if node_id not in visited:
            visit(node_id, [], set())
    return game


def _sanitize_persisted_action(value):
    if isinstance(value, list):
        for item in value:
            _sanitize_persisted_action(item)
        return value
    if not isinstance(value, dict):
        return value
    meta = value.get("meta")
    if isinstance(meta, dict):
        for field in _TRANSIENT_ACTION_META_FIELDS:
            meta.pop(field, None)
        if meta.get("source") == "local-legal-actions":
            meta.pop("source", None)
        if not meta:
            value.pop("meta", None)
    for child in value.values():
        _sanitize_persisted_action(child)
    return value


def _compact_game_structure_for_record(game):
    if not isinstance(game, dict):
        return game
    nodes = game.get("nodes")
    if not isinstance(nodes, dict):
        return game
    shared_match_state = game.get("matchState") if isinstance(game.get("matchState"), dict) else {}
    shared_seed = shared_match_state.get("seed", game.get("seed"))
    shared_round_seeds = shared_match_state.get("roundSeeds")

    _compact_action_histories_for_record(game)
    for node_id, node in nodes.items():
        if not isinstance(node, dict):
            continue
        snapshot = node.get("snapshot")
        if isinstance(snapshot, dict):
            kyoku_state = snapshot.get("kyokuState")
            if isinstance(kyoku_state, dict) and kyoku_state.get("pendingDoraRevealAfterActionCount"):
                snapshot["pendingDoraRevealAfterActionCount"] = int(
                    kyoku_state["pendingDoraRevealAfterActionCount"]
                )
            snapshot.pop("matchState", None)
            snapshot.pop("kyokuState", None)
            if shared_seed is not None and snapshot.get("seed") == shared_seed:
                snapshot.pop("seed", None)
            if shared_round_seeds is not None and snapshot.get("roundSeeds") == shared_round_seeds:
                snapshot.pop("roundSeeds", None)
            _sanitize_persisted_action(snapshot.get("lastAction"))
            _sanitize_persisted_action(snapshot.get("actionHistoryDelta"))
            _sanitize_persisted_action(snapshot.get("melds"))
        _sanitize_persisted_action(node.get("action"))
        for field in ("id", "type", "parentId", "actor", "depth", "isDecision"):
            node.pop(field, None)
        if not node.get("analysisCache"):
            node.pop("analysisCache", None)
        if not node.get(OPPONENT_ANALYSIS_CACHE_FIELD):
            node.pop(OPPONENT_ANALYSIS_CACHE_FIELD, None)
        if node.get("comparison") is None:
            node.pop("comparison", None)
        if node.get("mainChildId") is None:
            node.pop("mainChildId", None)

    game.pop("formatVersion", None)
    game.pop("treeRevision", None)
    if game.get("pendingReview") is None:
        game.pop("pendingReview", None)
    return game


def hydrate_game_structure(game, format_version):
    if format_version < RECORD_FORMAT_VERSION:
        return game
    nodes = game.get("nodes") if isinstance(game, dict) else None
    if not isinstance(nodes, dict):
        return game

    parent_by_child = {}
    for parent_id, parent in nodes.items():
        if not isinstance(parent, dict):
            raise ValueError(f"节点内容无效：{parent_id}")
        parent.setdefault("children", [])
        for child_id in parent["children"]:
            child_id = str(child_id)
            if child_id not in nodes:
                raise ValueError(f"存档引用了不存在的节点：{child_id}")
            existing = parent_by_child.setdefault(child_id, str(parent_id))
            if existing != str(parent_id):
                raise ValueError(f"节点被多个父节点引用：{child_id}")

    root_id = str(game.get("rootNodeId") or "")
    if root_id not in nodes:
        roots = [str(node_id) for node_id in nodes if str(node_id) not in parent_by_child]
        if len(roots) != 1:
            raise ValueError("存档无法确定唯一根节点。")
        root_id = roots[0]
        game["rootNodeId"] = root_id

    depth_cache = {}

    def resolve_depth(node_id, active):
        if node_id in depth_cache:
            return depth_cache[node_id]
        if node_id in active:
            raise ValueError("存档的节点树包含循环引用。")
        active.add(node_id)
        parent_id = parent_by_child.get(node_id)
        depth = 0 if parent_id is None else resolve_depth(parent_id, active) + 1
        active.remove(node_id)
        depth_cache[node_id] = depth
        return depth

    for node_id, node in nodes.items():
        node_id = str(node_id)
        parent_id = parent_by_child.get(node_id)
        node["id"] = node_id
        node["parentId"] = parent_id
        node["depth"] = resolve_depth(node_id, set())
        action = node.get("action")
        node["type"] = (
            "root"
            if node_id == root_id
            else ("decision" if isinstance(action, dict) and action.get("decisionOnly") else "action")
        )
        node["actor"] = action.get("actor") if isinstance(action, dict) else None
        node.setdefault("mainChildId", None)
        node.setdefault("analysisCache", {})
        if node["type"] == "decision":
            node["isDecision"] = True

    shared_match_state = game.get("matchState") if isinstance(game.get("matchState"), dict) else {}
    for node in nodes.values():
        snapshot = node.get("snapshot")
        if not isinstance(snapshot, dict):
            continue
        if "seed" not in snapshot and "seed" in shared_match_state:
            snapshot["seed"] = shared_match_state["seed"]
        if "roundSeeds" not in snapshot and "roundSeeds" in shared_match_state:
            snapshot["roundSeeds"] = copy.deepcopy(shared_match_state["roundSeeds"])
    _hydrate_round_states_from_record(game)
    _hydrate_action_histories_from_record(game)
    return game


def hydrate_round_walls(game):
    if not isinstance(game, dict):
        return game
    storage = game.get(_ROUND_WALL_STORAGE_FIELD)
    if not isinstance(storage, dict):
        converted_walls = {}
        for node in (game.get("nodes") or {}).values():
            snapshot = node.get("snapshot") if isinstance(node, dict) else None
            if not isinstance(snapshot, dict):
                continue
            full_wall = tuple(snapshot.get("fullWall") or ())
            if len(full_wall) != 136:
                continue
            converted = converted_walls.setdefault(full_wall, _convert_legacy_wall_layout(full_wall))
            snapshot["fullWall"] = converted
            kyoku_state = snapshot.get("kyokuState")
            if isinstance(kyoku_state, dict):
                kyoku_state["fullWall"] = converted

    raw_walls = storage.get("walls") if isinstance(storage, dict) else None
    storage_version = int(storage.get("schemaVersion") or 1) if isinstance(storage, dict) else _ROUND_WALL_LAYOUT_VERSION
    if not isinstance(raw_walls, dict):
        raw_walls = {}

    walls = {
        str(wall_id): (
            _convert_legacy_wall_layout(tuple(str(tile) for tile in tiles))
            if storage_version < _ROUND_WALL_LAYOUT_VERSION
            else tuple(str(tile) for tile in tiles)
        )
        for wall_id, tiles in raw_walls.items()
        if isinstance(tiles, list) and len(tiles) == 136
    }
    live_wall_cache = {}
    rinshan_cache = {}
    stack_cache = {}
    incomplete_wall_cache = {}
    was_reconstructed = isinstance((game.get("metadata") or {}).get("wallReconstruction"), dict)

    for node in (game.get("nodes") or {}).values():
        snapshot = node.get("snapshot") if isinstance(node, dict) else None
        if not isinstance(snapshot, dict):
            continue
        wall_state = snapshot.get(_SNAPSHOT_WALL_STATE_FIELD)
        if not isinstance(wall_state, dict):
            continue
        if wall_state.get("incomplete"):
            live_end = max(0, int(wall_state.get("liveEnd", 0)))
            live_wall = incomplete_wall_cache.setdefault(live_end, ("?",) * live_end)
            snapshot["fullWall"] = ()
            snapshot["wall"] = live_wall
            snapshot["rinshanWall"] = ()
            snapshot["doraIndicatorStack"] = ()
            snapshot["uraIndicatorStack"] = ()
            kyoku_state = snapshot.get("kyokuState")
            if isinstance(kyoku_state, dict):
                kyoku_state["fullWall"] = ()
                kyoku_state["wall"] = live_wall
                kyoku_state["rinshanWall"] = ()
                kyoku_state["doraIndicatorStack"] = ()
                kyoku_state["uraIndicatorStack"] = ()
            continue
        wall_id = str(wall_state.get("ref") or "")
        full_wall = walls.get(wall_id)
        if full_wall is None:
            raise ValueError(f"存档引用了不存在的牌山：{wall_id or '空引用'}")

        live_end = max(0, min(122, int(wall_state.get("liveEnd", 122))))
        rinshan_drawn = max(0, min(4, int(wall_state.get("rinshanDrawn", 0))))
        live_wall = live_wall_cache.setdefault((wall_id, live_end), full_wall[:live_end])
        rinshan_order, dora_stack, ura_stack = stack_cache.setdefault(
            wall_id,
            (
                tuple(full_wall[index] for index in RINSHAN_DRAW_POSITIONS),
                tuple(full_wall[index] for index in DORA_INDICATOR_POSITIONS),
                tuple(full_wall[index] for index in URA_INDICATOR_POSITIONS),
            ),
        )
        rinshan_wall = rinshan_cache.setdefault(
            (wall_id, rinshan_drawn),
            rinshan_order[rinshan_drawn:],
        )
        snapshot["fullWall"] = full_wall
        snapshot["wall"] = live_wall
        snapshot["rinshanWall"] = rinshan_wall
        snapshot["doraIndicatorStack"] = dora_stack
        snapshot["uraIndicatorStack"] = ura_stack
        if was_reconstructed:
            snapshot.setdefault("wallOrigin", "reconstructed")

        kyoku_state = snapshot.get("kyokuState")
        if isinstance(kyoku_state, dict):
            kyoku_state["fullWall"] = full_wall
            kyoku_state["wall"] = live_wall
            kyoku_state["rinshanWall"] = rinshan_wall
            kyoku_state["doraIndicatorStack"] = dora_stack
            kyoku_state["uraIndicatorStack"] = ura_stack
            if was_reconstructed:
                kyoku_state.setdefault("wallOrigin", "reconstructed")
    return game


def repair_tsumo_action_tiles(game):
    """Repair records created when TSUMO nodes used the sorted hand's last tile."""
    changed = False
    for node in (game.get("nodes") or {}).values():
        if not isinstance(node, dict):
            continue
        action = node.get("action")
        snapshot = node.get("snapshot")
        if not isinstance(action, dict) or action.get("type") != "tsumo" or not isinstance(snapshot, dict):
            continue
        last_action = snapshot.get("lastAction")
        if (
            not isinstance(last_action, dict)
            or last_action.get("type") != "tsumo"
            or last_action.get("actor") != action.get("actor")
            or not last_action.get("pai")
            or last_action.get("pai") == action.get("pai")
        ):
            continue
        action["pai"] = str(last_action["pai"])
        changed = True
    return changed


def serialize_game_record_parts(game_copy, state_copy):
    _compact_round_walls_for_record(game_copy)
    _compact_round_states_for_record(game_copy)
    _compact_game_structure_for_record(game_copy)
    return {
        "formatVersion": RECORD_FORMAT_VERSION,
        "savedAt": now_iso(),
        "state": {
            "mode": state_copy["mode"],
            "controlledSeat": state_copy["controlledSeat"],
            "visibleHands": state_copy["visibleHands"],
        },
        "game": game_copy,
    }


