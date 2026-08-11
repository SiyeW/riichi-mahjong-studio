from __future__ import annotations

import copy
import random
from collections import Counter
from typing import Any, Dict, Iterable, List

from service_helpers import (
    DORA_INDICATOR_POSITIONS,
    RINSHAN_DRAW_POSITIONS,
    URA_INDICATOR_POSITIONS,
    build_round_seed_stream,
    build_wall,
)


DORA_POSITIONS = DORA_INDICATOR_POSITIONS
URA_POSITIONS = URA_INDICATOR_POSITIONS
KAN_ACTIONS = {"ankan", "daiminkan", "kakan"}


def normalize_reconstruction_seed(value: Any) -> int:
    if value is None or str(value).strip() == "":
        return random.SystemRandom().randint(100000, 999999999)
    try:
        seed = int(str(value).strip(), 10)
    except (TypeError, ValueError) as exc:
        raise ValueError("种子必须是整数。") from exc
    if seed < 0 or seed > 2**31 - 1:
        raise ValueError("种子必须在 0 到 2147483647 之间。")
    return seed


def _mainline_nodes(game: Dict[str, Any]) -> List[Dict[str, Any]]:
    nodes = game.get("nodes") or {}
    node_id = game.get("rootNodeId")
    result = []
    visited = set()
    while node_id and node_id not in visited:
        visited.add(node_id)
        node = nodes.get(node_id)
        if not isinstance(node, dict):
            break
        result.append(node)
        node_id = node.get("mainChildId")
    return result


def _round_groups(game: Dict[str, Any]) -> List[List[Dict[str, Any]]]:
    groups: List[List[Dict[str, Any]]] = []
    for node in _mainline_nodes(game):
        action_type = str((node.get("action") or {}).get("type") or "")
        if action_type == "start_kyoku":
            groups.append([])
        if groups:
            groups[-1].append(node)

    root = (game.get("nodes") or {}).get(game.get("rootNodeId"))
    if groups and isinstance(root, dict) and root not in groups[0]:
        groups[0].insert(0, root)
    return groups


def _known_tile(tile: Any) -> str | None:
    value = str(tile or "")
    return value if value and value != "?" else None


def _assign_known(
    positions: List[str | None],
    index: int,
    tile: Any,
    context: str,
) -> None:
    value = _known_tile(tile)
    if value is None:
        return
    if not 0 <= index < len(positions):
        raise ValueError(f"{context}超出了牌山范围。")
    previous = positions[index]
    if previous is not None and previous != value:
        raise ValueError(f"{context}与牌谱中的另一条记录冲突。")
    positions[index] = value


def _initial_wall_hands(snapshot: Dict[str, Any]) -> List[List[str]]:
    raw = snapshot.get("reportedInitialHands")
    if not isinstance(raw, list) or len(raw) != 4:
        raw = snapshot.get("initialHands")
    if not isinstance(raw, list) or len(raw) != 4:
        raise ValueError("牌谱缺少四家的起手牌。")
    result = []
    for hand in raw:
        if not isinstance(hand, list) or len(hand) != 13:
            raise ValueError("牌谱中的起手牌数量不正确。")
        result.append([str(tile) for tile in hand])
    return result


def _round_seed(round_seeds: List[int], round_index: int, honba: int) -> int:
    if round_index < 0:
        raise ValueError("牌谱中的局序号不正确。")
    if round_index >= len(round_seeds):
        raise ValueError("内部小局种子不足。")
    return int(round_seeds[round_index]) + max(0, honba) * 7919


def _build_round_wall(
    group: List[Dict[str, Any]],
    round_seeds: List[int],
) -> tuple[List[str], List[tuple[int, int]]]:
    start_snapshot = group[0].get("snapshot") or {}
    for node in group:
        snapshot = node.get("snapshot") or {}
        if str((node.get("action") or {}).get("type") or "") == "start_kyoku":
            start_snapshot = snapshot
            break

    round_index = int(start_snapshot.get("roundIndex", 0))
    honba = int(start_snapshot.get("honba", 0))
    positions: List[str | None] = [None] * 136
    for seat, hand in enumerate(_initial_wall_hands(start_snapshot)):
        for offset, tile in enumerate(hand):
            _assign_known(positions, seat * 13 + offset, tile, "起手牌")

    initial_doras = list(start_snapshot.get("doraIndicators") or [])
    if initial_doras:
        _assign_known(positions, DORA_POSITIONS[0], initial_doras[0], "初始宝牌指示牌")

    normal_draw_count = 0
    rinshan_draw_count = 0
    dora_count = len(initial_doras)
    pending_rinshan = False
    progress: List[tuple[int, int]] = []
    ura_markers: List[str] = []

    for node in group:
        action = {} if node.get("type") == "decision" else (node.get("action") or {})
        action_type = str(action.get("type") or "")
        if action_type in KAN_ACTIONS:
            pending_rinshan = True
        elif action_type == "tsumo":
            if pending_rinshan:
                if rinshan_draw_count >= len(RINSHAN_DRAW_POSITIONS):
                    raise ValueError("牌谱中的岭上摸牌超过四张。")
                _assign_known(
                    positions,
                    RINSHAN_DRAW_POSITIONS[rinshan_draw_count],
                    action.get("pai"),
                    "岭上摸牌",
                )
                rinshan_draw_count += 1
                pending_rinshan = False
            else:
                index = 52 + normal_draw_count
                if index >= 122 - rinshan_draw_count:
                    raise ValueError("牌谱中的普通摸牌超过可用牌山。")
                _assign_known(positions, index, action.get("pai"), "普通摸牌")
                normal_draw_count += 1
        elif action_type == "dora":
            if dora_count >= len(DORA_POSITIONS):
                raise ValueError("牌谱中的宝牌指示牌超过五张。")
            _assign_known(
                positions,
                DORA_POSITIONS[dora_count],
                action.get("dora_marker") or action.get("doraMarker"),
                "宝牌指示牌",
            )
            dora_count += 1
        elif action_type == "hora":
            markers = action.get("ura_markers") or action.get("uraMarkers") or []
            if isinstance(markers, list) and len(markers) > len(ura_markers):
                ura_markers = [str(tile) for tile in markers]
        progress.append((normal_draw_count, rinshan_draw_count))

    for index, tile in enumerate(ura_markers[: len(URA_POSITIONS)]):
        _assign_known(positions, URA_POSITIONS[index], tile, "里宝牌指示牌")

    remaining = Counter(build_wall(random.Random(0)))
    for tile in positions:
        if tile is None:
            continue
        if remaining[tile] <= 0:
            label = f"{start_snapshot.get('bakaze', 'E')}{start_snapshot.get('kyoku', 1)}-{honba}"
            raise ValueError(f"{label} 的已知牌张数量冲突：{tile} 超过四张。")
        remaining[tile] -= 1

    filler = list(remaining.elements())
    random.Random(_round_seed(round_seeds, round_index, honba)).shuffle(filler)
    filler_iter = iter(filler)
    full_wall = [tile if tile is not None else next(filler_iter) for tile in positions]
    return full_wall, progress


def _snapshot_match_state(
    game: Dict[str, Any],
    snapshot: Dict[str, Any],
    seed: int,
    round_seeds: List[int],
) -> Dict[str, Any]:
    config = game.get("matchConfig") or {}
    state = copy.deepcopy(snapshot.get("matchState") or {})
    state.update({
        "matchId": game.get("matchId") or game.get("gameId"),
        "seed": seed,
        "matchType": config.get("matchType", "hanchan"),
        "players": 4,
        "roundIndex": int(snapshot.get("roundIndex", 0)),
        "bakaze": snapshot.get("bakaze", "E"),
        "kyoku": int(snapshot.get("kyoku", 1)),
        "honba": int(snapshot.get("honba", 0)),
        "kyotaku": int(snapshot.get("kyotaku", 0)),
        "dealer": int(snapshot.get("dealer", 0)),
        "scores": copy.deepcopy(snapshot.get("scores", [25000] * 4)),
        "westEntryEnabled": bool(config.get("westEntryEnabled", True)),
        "westEntered": bool(snapshot.get("westEntered", False)),
        "maxBakaze": config.get("maxBakaze", "W"),
        "maxKyoku": int(config.get("maxKyoku", 4)),
        "ended": snapshot.get("phase") == "match_end",
        "inRenchan": bool(snapshot.get("inRenchan", False)),
        "roundSeeds": copy.deepcopy(round_seeds),
    })
    return state


def _patch_snapshot(
    game: Dict[str, Any],
    snapshot: Dict[str, Any],
    full_wall: List[str],
    progress: tuple[int, int],
    seed: int,
    round_seeds: List[int],
) -> None:
    normal_draw_count, rinshan_draw_count = progress
    wall_length = 122 - rinshan_draw_count
    rinshan_tiles = [full_wall[index] for index in RINSHAN_DRAW_POSITIONS]
    dora_stack = [full_wall[index] for index in DORA_POSITIONS]
    ura_stack = [full_wall[index] for index in URA_POSITIONS]
    snapshot["seed"] = seed
    snapshot["roundSeeds"] = copy.deepcopy(round_seeds)
    full_wall_tuple = tuple(full_wall)
    snapshot["fullWall"] = full_wall_tuple
    snapshot["wall"] = full_wall_tuple[:wall_length]
    snapshot["wallOrigin"] = "reconstructed"
    snapshot["rinshanWall"] = tuple(rinshan_tiles[rinshan_draw_count:])
    snapshot["drawIndex"] = 52 + normal_draw_count
    snapshot["doraIndicatorStack"] = tuple(dora_stack)
    snapshot["uraIndicatorStack"] = tuple(ura_stack)
    snapshot["matchState"] = _snapshot_match_state(game, snapshot, seed, round_seeds)

    kyoku_state = snapshot.get("kyokuState")
    if isinstance(kyoku_state, dict):
        kyoku_state["fullWall"] = copy.deepcopy(snapshot["fullWall"])
        kyoku_state["wall"] = copy.deepcopy(snapshot["wall"])
        kyoku_state["wallOrigin"] = "reconstructed"
        kyoku_state["rinshanWall"] = copy.deepcopy(snapshot["rinshanWall"])
        kyoku_state["drawIndex"] = snapshot["drawIndex"]
        kyoku_state["doraIndicatorStack"] = copy.deepcopy(dora_stack)
        kyoku_state["uraIndicatorStack"] = copy.deepcopy(ura_stack)


def reconstruct_imported_walls(
    game: Dict[str, Any],
    seed_value: Any = None,
    *,
    generated_at: str,
) -> Dict[str, Any]:
    metadata = game.get("metadata")
    if not isinstance(metadata, dict) or metadata.get("source") not in ("mortal-report", "tenhou-custom"):
        raise ValueError("只有导入的牌谱可以重建牌山。")

    seed = normalize_reconstruction_seed(seed_value)
    round_seeds = build_round_seed_stream(random.Random(seed))
    groups = _round_groups(game)
    if not groups:
        raise ValueError("牌谱中没有可以重建的小局。")

    reconstructed = []
    for group in groups:
        full_wall, progress = _build_round_wall(group, round_seeds)
        if len(progress) != len(group):
            raise RuntimeError("牌山重建进度与节点数量不一致。")
        for node, node_progress in zip(group, progress):
            snapshot = node.get("snapshot")
            if isinstance(snapshot, dict):
                _patch_snapshot(game, snapshot, full_wall, node_progress, seed, round_seeds)
        reconstructed.append({
            "roundIndex": int((group[0].get("snapshot") or {}).get("roundIndex", 0)),
            "honba": int((group[0].get("snapshot") or {}).get("honba", 0)),
        })

    game["seed"] = seed
    game_state = game.setdefault("matchState", {})
    game_state["seed"] = seed
    game_state["roundSeeds"] = copy.deepcopy(round_seeds)
    metadata["readOnly"] = False
    metadata.pop("readOnlyReason", None)
    metadata["wallReconstruction"] = {
        "schemaVersion": 1,
        "seed": seed,
        "generatedAt": generated_at,
        "roundCount": len(reconstructed),
        "unknownTiles": "seeded-completion",
    }
    return {
        "seed": seed,
        "roundCount": len(reconstructed),
    }
