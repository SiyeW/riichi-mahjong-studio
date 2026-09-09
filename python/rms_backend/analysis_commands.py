"""Commands for analysis sessions, caches, and diagnostic payloads."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from . import game_tree
from .analysis_cache import (
    ANALYSIS_SOURCES_FIELD,
    OPPONENT_ANALYSIS_CACHE_FIELD,
)


class AnalysisCommands:
    def __init__(
        self,
        *,
        state: dict[str, Any],
        auto_analysis: Any,
        play_prefetch: Any,
        decision_analysis: Any,
        opponent_predictions: Any,
        engine_management: Any,
        opponent_analysis: Any,
        view_builder: Any,
        ensure_game_loaded: Callable[[], None],
        get_action_debug: Callable[[], Any],
        get_opponent_debug: Callable[[], Any],
        now_iso: Callable[[], str],
    ) -> None:
        self._state = state
        self._auto_analysis = auto_analysis
        self._play_prefetch = play_prefetch
        self._decision_analysis = decision_analysis
        self._opponent_predictions = opponent_predictions
        self._engine_management = engine_management
        self._opponent_analysis = opponent_analysis
        self._view_builder = view_builder
        self._ensure_game_loaded = ensure_game_loaded
        self._get_action_debug = get_action_debug
        self._get_opponent_debug = get_opponent_debug
        self._now_iso = now_iso

    def start_auto(self, request_id: Any, command: str) -> dict[str, Any]:
        return self._view_builder.build_response(
            request_id,
            command,
            {"autoAnalysis": self._auto_analysis.start()},
        )

    def cancel_auto(self, request_id: Any, command: str) -> dict[str, Any]:
        return self._view_builder.build_response(
            request_id,
            command,
            {"autoAnalysis": self._auto_analysis.cancel()},
        )

    def describe(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        return self._view_builder.build_response(
            request_id,
            command,
            {"description": self._engine_management.describe(payload)},
        )

    def latest_action_debug(
        self,
        request_id: Any,
        command: str,
    ) -> dict[str, Any]:
        return self._view_builder.build_response(
            request_id,
            command,
            {"debug": self._get_action_debug()},
        )

    def current_opponent_analysis(
        self,
        request_id: Any,
        command: str,
    ) -> dict[str, Any]:
        return self._view_builder.build_response(
            request_id,
            command,
            self._opponent_analysis.current(),
        )

    def latest_opponent_debug(
        self,
        request_id: Any,
        command: str,
    ) -> dict[str, Any]:
        return self._view_builder.build_response(
            request_id,
            command,
            {"debug": self._get_opponent_debug()},
        )

    def clear_caches(self, request_id: Any, command: str) -> dict[str, Any]:
        return {
            "request_id": request_id,
            "command": command,
            "state": self._view_builder.build_state_payload(),
            "cleared": self._clear_loaded_caches(),
            "timestamp": self._now_iso(),
        }

    def _clear_loaded_caches(self) -> dict[str, Any]:
        self._ensure_game_loaded()
        self._play_prefetch.cancel()
        game = self._state["game"]
        game_id = game.get("gameId")

        self._auto_analysis.cancel("缓存已清除")
        decision_epoch, opponent_epoch = self._engine_management.advance_cache_epochs()
        self._decision_analysis.purge(game_id)
        self._opponent_predictions.cancel_all()

        decision_entries = 0
        opponent_entries = 0
        comparisons = 0
        for node in game.get("nodes", {}).values():
            decision_cache = node.get("analysisCache")
            if isinstance(decision_cache, dict):
                decision_entries += len(decision_cache)
            node["analysisCache"] = {}

            opponent_cache = node.pop(OPPONENT_ANALYSIS_CACHE_FIELD, None)
            if isinstance(opponent_cache, dict):
                opponent_entries += len(opponent_cache)

            if node.get("comparison") is not None:
                comparisons += 1
                node["comparison"] = None

        had_pending_review = game.get("pendingReview") is not None
        game["pendingReview"] = None
        game[ANALYSIS_SOURCES_FIELD] = {}
        self._auto_analysis.invalidate_timeline()
        game_tree.mark_tree_changed(game)
        return {
            "decisionEntries": decision_entries,
            "decisionCacheEpoch": decision_epoch,
            "opponentCacheEpoch": opponent_epoch,
            "opponentEntries": opponent_entries,
            "comparisons": comparisons,
            "pendingReview": had_pending_review,
            "treeRevision": int(game.get("treeRevision", 0)),
        }
