from __future__ import annotations

import copy
from collections.abc import Callable, MutableMapping
from dataclasses import dataclass
from typing import Any

from . import game_tree


@dataclass(frozen=True)
class RoundWallReplacementDependencies:
    ensure_game_loaded: Callable[[], None]
    validate_full_wall: Callable[[Any], list[str]]
    create_initial_snapshot: Callable[[dict[str, Any], list[str]], dict[str, Any]]
    resolve_round_root: Callable[[dict[str, Any], str], str]
    collect_subtree_ids: Callable[[dict[str, Any], str], list[str]]
    purge_decision_analysis: Callable[..., None]
    invalidate_analysis_timeline: Callable[[], None]
    promote_mainline: Callable[..., None]
    purge_mjai_cache: Callable[[str], None]


class RoundWallReplacement:
    """Replace one round root and retire its tree-derived analysis artifacts."""

    def __init__(
        self,
        state: MutableMapping[str, Any],
        dependencies: RoundWallReplacementDependencies,
    ) -> None:
        self._state = state
        self._dependencies = dependencies

    def replace(self, full_wall: Any) -> str:
        self._dependencies.ensure_game_loaded()
        game = self._state["game"]
        current_node_id = game["currentNodeId"]
        old_round_root_id = self._dependencies.resolve_round_root(
            game,
            current_node_id,
        )
        round_root_node = game["nodes"][old_round_root_id]
        base_match_state = copy.deepcopy(
            (round_root_node.get("snapshot") or {}).get("matchState")
            or game.get("matchState")
            or {}
        )
        if not base_match_state:
            raise ValueError("无法确定当前局的对局元数据。")

        validated_wall = self._dependencies.validate_full_wall(full_wall)
        next_snapshot = self._dependencies.create_initial_snapshot(
            base_match_state,
            validated_wall,
        )
        next_snapshot["wallOrigin"] = "imported"

        subtree_ids = self._dependencies.collect_subtree_ids(
            game,
            old_round_root_id,
        )
        parent_id = round_root_node.get("parentId")
        new_round_root_id = f"n_{game['nextNodeIndex']}"
        game["nextNodeIndex"] += 1
        new_round_root_node = {
            "id": new_round_root_id,
            "type": round_root_node.get("type", "action"),
            "parentId": parent_id,
            "children": [],
            "mainChildId": None,
            "action": copy.deepcopy(round_root_node.get("action")),
            "actor": (
                None
                if round_root_node.get("action") is None
                else round_root_node["action"].get("actor")
            ),
            "snapshot": next_snapshot,
            "analysisCache": {},
            "depth": round_root_node.get("depth", 0),
        }

        if parent_id:
            parent_node = game["nodes"][parent_id]
            parent_node["children"] = [
                new_round_root_id if child_id == old_round_root_id else child_id
                for child_id in parent_node.get("children", [])
            ]
            if parent_node.get("mainChildId") == old_round_root_id:
                parent_node["mainChildId"] = new_round_root_id
        else:
            game["rootNodeId"] = new_round_root_id

        self._dependencies.purge_decision_analysis(game["gameId"], subtree_ids)
        for node_id in subtree_ids:
            game["nodes"].pop(node_id, None)

        game["nodes"][new_round_root_id] = new_round_root_node
        game_tree.mark_tree_changed(game)
        self._dependencies.invalidate_analysis_timeline()
        game["currentNodeId"] = new_round_root_id
        self._dependencies.promote_mainline(game, new_round_root_id)
        game["matchState"] = copy.deepcopy(next_snapshot["matchState"])
        game["matchState"]["matchId"] = game.get(
            "matchId",
            game.get("gameId", "game"),
        )
        self._dependencies.purge_mjai_cache(game["gameId"])
        return new_round_root_id
