from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import game_tree


@dataclass(frozen=True)
class GameTreeDependencies:
    sync_snapshot: Callable[[dict[str, Any]], Any]
    is_meaningful_decision: Callable[[dict[str, Any], dict[str, Any]], bool]
    active_draft: Callable[[], dict[str, Any] | None]
    invalidate_analysis_timeline: Callable[[], None]


class GameTreeCoordinator:
    """Apply tree edits together with mainline policy and analysis invalidation."""

    def __init__(
        self,
        state: dict[str, Any],
        dependencies: GameTreeDependencies,
    ) -> None:
        self._state = state
        self._dependencies = dependencies

    def refresh_reused_imported_child(
        self,
        game: dict[str, Any],
        child_id: str,
        action: dict[str, Any],
        snapshot: dict[str, Any],
    ) -> None:
        if game_tree.refresh_reused_imported_child(
            game,
            child_id,
            action,
            snapshot,
        ):
            self._dependencies.invalidate_analysis_timeline()

    def create_node(
        self,
        game: dict[str, Any],
        parent_id: str,
        action: dict[str, Any],
        snapshot: dict[str, Any],
    ) -> str:
        self._dependencies.sync_snapshot(snapshot)
        parent = game["nodes"][parent_id]
        is_decision = self._dependencies.is_meaningful_decision(
            parent.get("snapshot"),
            action,
        )
        previous_revision = int(game.get("treeRevision", 0))
        node_id = game_tree.create_node(
            game,
            parent_id,
            action,
            snapshot,
            is_decision=is_decision,
        )
        if int(game.get("treeRevision", 0)) != previous_revision:
            self._dependencies.invalidate_analysis_timeline()
        return node_id

    def attach_mainline(
        self,
        parent_id: str,
        child_id: str,
        *,
        force: bool = False,
    ) -> None:
        game = self._dependencies.active_draft() or self._state["game"]
        if game_tree.attach_main_child(
            game,
            parent_id,
            child_id,
            replace_existing=self._may_promote_mainline(game, force),
        ):
            self._dependencies.invalidate_analysis_timeline()

    def promote_path_to_mainline(
        self,
        game: dict[str, Any],
        node_id: str,
        *,
        force: bool = False,
    ) -> None:
        if not self._may_promote_mainline(game, force):
            return
        if game_tree.promote_path_to_mainline(game, node_id):
            self._dependencies.invalidate_analysis_timeline()

    def replace_pending_review_main_child(
        self,
        game: dict[str, Any],
        parent_id: str,
        proposed_id: str,
        chosen_id: str,
    ) -> bool:
        changed = game_tree.replace_pending_review_main_child(
            game,
            parent_id,
            proposed_id,
            chosen_id,
        )
        if changed:
            self._dependencies.invalidate_analysis_timeline()
        return changed

    def _may_promote_mainline(
        self,
        game: dict[str, Any],
        force: bool,
    ) -> bool:
        return (
            force
            or self._state.get("mode") != "play"
            or self._dependencies.active_draft() is game
        )
