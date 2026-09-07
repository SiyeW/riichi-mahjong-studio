"""Tree-editing commands for the active game record."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Callable, MutableMapping

import game_tree


State = MutableMapping[str, Any]
Game = dict[str, Any]


@dataclass
class RecordCommandDependencies:
    ensure_loaded: Callable[[], None]
    ensure_writable: Callable[[], None]
    round_root_for_node: Callable[[Game, str], str]
    collect_subtree_ids: Callable[[Game, str], list[str]]
    cancel_play_prefetch: Callable[[], None]
    cancel_auto_analysis: Callable[[str], Any]
    schedule_auto_reprioritization: Callable[[Game, str], None]
    purge_background_analysis: Callable[..., None]
    purge_mjai_cache: Callable[[str], None]
    sync_snapshot: Callable[[dict], Any]
    request_opponent_analysis: Callable[..., Any]
    promote_mainline: Callable[..., Any]
    invalidate_auto_timeline: Callable[[], None]


class RecordCommands:
    """Owns navigation and user-authored mutations within one loaded record."""

    COMMENT_MAX_LENGTH = 20_000

    def __init__(self, state: State, dependencies: RecordCommandDependencies):
        self._state = state
        self.dependencies = dependencies

    def jump(self, node_id: str) -> bool:
        self.dependencies.ensure_loaded()
        game = self._state["game"]
        if node_id not in game["nodes"]:
            raise ValueError(f"Unknown node id: {node_id}")
        previous_round = self.dependencies.round_root_for_node(game, game["currentNodeId"])
        self.dependencies.cancel_play_prefetch()
        game["currentNodeId"] = node_id
        game["pendingReview"] = None
        self.dependencies.schedule_auto_reprioritization(game, node_id)
        snapshot = game["nodes"][node_id].get("snapshot")
        if snapshot and self._state.get("mode") == "research":
            self.dependencies.sync_snapshot(snapshot)
            self.dependencies.request_opponent_analysis(snapshot)
        return previous_round == self.dependencies.round_root_for_node(game, node_id)

    def set_main_branch(self, node_id: str) -> None:
        self.dependencies.ensure_writable()
        game = self._state["game"]
        if node_id not in game["nodes"]:
            raise ValueError(f"Unknown node id: {node_id}")
        self.dependencies.promote_mainline(game, node_id, force=True)

    def set_comment(self, node_id: str, value: Any) -> tuple[bool, str]:
        self.dependencies.ensure_loaded()
        game = self._state["game"]
        node = game["nodes"].get(node_id)
        if not isinstance(node, dict):
            raise ValueError(f"Unknown node id: {node_id}")
        comment = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
        if len(comment) > self.COMMENT_MAX_LENGTH:
            raise ValueError(f"Node comment exceeds {self.COMMENT_MAX_LENGTH} characters.")
        previous = str(node.get("comment") or "")
        if comment:
            node["comment"] = comment
        else:
            node.pop("comment", None)
        return previous != comment, comment

    def delete(self, node_id: str) -> int:
        self.dependencies.ensure_writable()
        game = self._state["game"]
        nodes = game["nodes"]
        node = nodes.get(node_id)
        if not isinstance(node, dict):
            raise ValueError(f"Unknown node id: {node_id}")
        if node_id != game.get("currentNodeId"):
            raise ValueError("Only the current node can be deleted.")
        parent_id = node.get("parentId")
        if not parent_id or parent_id not in nodes:
            raise ValueError("The root node cannot be deleted.")

        subtree_ids = self.dependencies.collect_subtree_ids(game, node_id)
        subtree_id_set = set(subtree_ids)
        parent = nodes[parent_id]
        remaining_children = [
            child_id for child_id in parent.get("children", [])
            if child_id != node_id and child_id in nodes
        ]
        self.dependencies.cancel_play_prefetch()
        self.dependencies.cancel_auto_analysis("节点已删除")
        self.dependencies.purge_background_analysis(game.get("gameId"), subtree_ids)
        self.dependencies.purge_mjai_cache(game.get("gameId"))

        parent["children"] = remaining_children
        if parent.get("mainChildId") == node_id:
            parent["mainChildId"] = remaining_children[0] if remaining_children else None
        for subtree_id in subtree_ids:
            nodes.pop(subtree_id, None)
        if game.get("mainLeafNodeId") in subtree_id_set:
            cursor_id = game.get("rootNodeId")
            seen = set()
            while cursor_id in nodes and cursor_id not in seen:
                seen.add(cursor_id)
                cursor = nodes[cursor_id]
                main_child_id = cursor.get("mainChildId")
                if main_child_id not in cursor.get("children", []) or main_child_id not in nodes:
                    cursor["mainChildId"] = None
                    break
                cursor_id = main_child_id
            game["mainLeafNodeId"] = cursor_id if cursor_id in nodes else parent_id

        game["currentNodeId"] = parent_id
        game["pendingReview"] = None
        parent_snapshot = parent.get("snapshot")
        if isinstance(parent_snapshot, dict):
            self.dependencies.sync_snapshot(parent_snapshot)
            game["matchState"] = copy.deepcopy(parent_snapshot["matchState"])
            game["matchState"]["matchId"] = game.get("matchId", game.get("gameId", "game"))
        game_tree.mark_tree_changed(game)
        self.dependencies.invalidate_auto_timeline()
        if self._state.get("mode") == "research":
            self.dependencies.request_opponent_analysis(parent_snapshot)
        return len(subtree_ids)
