"""Build renderer-facing state, table, tree, and response payloads."""

from __future__ import annotations

import copy
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import result_view
import table_view
import tree_view


@dataclass(frozen=True)
class EnvironmentViewDependencies:
    sync_snapshot: Callable[[dict[str, Any]], None]
    is_read_only_game: Callable[..., bool]
    actor_just_drew: Callable[[dict[str, Any], int], bool]
    can_declare_tsumo: Callable[[dict[str, Any], int], bool]
    can_ankan: Callable[[dict[str, Any], int], bool]
    get_node_legal_actions: Callable[..., list[dict[str, Any]]]
    resolve_round_root: Callable[[dict[str, Any], str], str]
    decision_analysis: Any
    opponent_analysis: Any
    action_recommendations: Any
    opponent_predictions: Any
    engine_management: Any
    auto_analysis: Any
    consume_thinking_time: Callable[[], float]
    now_iso: Callable[[], str]


class EnvironmentView:
    """Read environment state and produce immutable renderer payloads."""

    def __init__(
        self,
        state: dict[str, Any],
        dependencies: EnvironmentViewDependencies,
    ) -> None:
        self.state = state
        self.dependencies = dependencies

    def normalize_tree_cursor(
        self,
        game: dict[str, Any],
        seat: int,
    ) -> str:
        return tree_view.normalize_current_cursor(game, seat)

    def build_tree(
        self,
        game: dict[str, Any],
        current_node_id: str,
    ) -> dict[str, Any]:
        return tree_view.build_tree_view(
            game,
            current_node_id,
            controlled_seat=int(self.state["controlledSeat"]),
            legal_actions_resolver=self.dependencies.get_node_legal_actions,
            result_info_builder=self.build_result_info,
        )

    def build_tree_cursor(
        self,
        game: dict[str, Any],
        current_node_id: str,
    ) -> dict[str, Any]:
        return tree_view.build_cursor_view(
            game,
            current_node_id,
            controlled_seat=int(self.state["controlledSeat"]),
            round_root_resolver=self.dependencies.resolve_round_root,
        )

    def build_result_info(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        self.dependencies.sync_snapshot(snapshot)
        return result_view.build_result_info(
            snapshot,
            int(self.state["controlledSeat"]),
        )

    def build_view_payload(self, compact_tree: bool = False) -> dict[str, Any]:
        if not self.state["gameLoaded"] or not self.state["game"]:
            return self._empty_view()

        game = self.state["game"]
        metadata = game.get("metadata") or {}
        current_node_id = self.normalize_tree_cursor(
            game,
            self.state["controlledSeat"],
        )
        current_node = game["nodes"][current_node_id]
        snapshot = current_node["snapshot"]
        self.dependencies.sync_snapshot(snapshot)
        opponent_analysis = None
        if self.state.get("opponentAnalysisEnabled"):
            opponent_analysis = self.dependencies.opponent_analysis.current()
        legal_actions = self.dependencies.get_node_legal_actions(
            game,
            current_node_id,
        )
        if legal_actions and self.state.get("decisionRecommendationsEnabled", True):
            analysis = self.dependencies.decision_analysis.get_or_schedule(
                current_node,
                snapshot,
                legal_actions,
            )
        else:
            analysis = None
        tree = (
            self.build_tree_cursor(game, current_node_id)
            if compact_tree
            else self.build_tree(game, current_node_id)
        )
        return {
            "gameId": game["gameId"],
            "matchId": game.get("matchId") or game["gameId"],
            "readOnly": bool(metadata.get("readOnly")),
            "sourceUrl": metadata.get("sourceUrl"),
            "readOnlyReason": metadata.get("readOnlyReason"),
            "currentNodeId": current_node_id,
            "nodeComment": str(current_node.get("comment") or ""),
            "opponentAnalysis": opponent_analysis,
            "matchSummary": self._build_match_summary(game, snapshot),
            "table": self._build_table(snapshot),
            "legalActions": legal_actions,
            "analysis": analysis,
            "comparison": copy.deepcopy(current_node.get("comparison")),
            "pendingReview": copy.deepcopy(game.get("pendingReview")),
            "tree": tree,
        }

    def build_state_payload(
        self,
        *,
        consume_thinking_time: bool = True,
    ) -> dict[str, Any]:
        dependencies = self.dependencies
        return {
            "mode": self.state["mode"],
            "controlledSeat": self.state["controlledSeat"],
            "pendingSeatSwitch": self.state["pendingSeatSwitch"],
            "visibleHands": self.state["visibleHands"],
            "license": copy.deepcopy(self.state.get("license")),
            "device": dependencies.action_recommendations.device_str,
            "gameLoaded": self.state["gameLoaded"],
            "aiThinkingTimeS": (
                dependencies.consume_thinking_time()
                if consume_thinking_time
                else 0.0
            ),
            "modelPerformance": {
                "decision": dependencies.engine_management.decision_response_ms(),
                "opponentAnalysis": dependencies.opponent_predictions.average_response_ms(),
            },
            "analysisVisibility": {
                "decisionRecommendations": bool(
                    self.state.get("decisionRecommendationsEnabled", True)
                ),
                "opponentAnalysis": bool(
                    self.state.get("opponentAnalysisEnabled", False)
                ),
            },
            "modelActivity": {
                "decision": dependencies.action_recommendations.get_activity(),
                "opponentAnalysis": dependencies.opponent_predictions.activity_state(),
                "errors": {
                    "decision": dependencies.action_recommendations.get_activity_errors(),
                    "opponentAnalysis": dependencies.opponent_predictions.activity_error(),
                },
            },
            "modelRuntime": {
                "decision": dependencies.action_recommendations.runtime_status(),
                "opponentAnalysis": dependencies.opponent_predictions.runtime_status(),
            },
            "autoAnalysis": dependencies.auto_analysis.status(
                include_timeline=self.state.get("mode") == "research"
            ),
        }

    def build_response(
        self,
        request_id: Any,
        command: str,
        extra: dict[str, Any] | None = None,
        compact_tree: bool = False,
    ) -> dict[str, Any]:
        view = self.build_view_payload(compact_tree=compact_tree)
        payload = {
            "request_id": request_id,
            "command": command,
            "state": self.build_state_payload(),
            "view": view,
            "timestamp": self.dependencies.now_iso(),
        }
        if extra:
            payload.update(extra)
        return payload

    def build_status_response(self, request_id: Any) -> dict[str, Any]:
        return {
            "request_id": request_id,
            "command": "get_status",
            "state": self.build_state_payload(consume_thinking_time=False),
            "timestamp": self.dependencies.now_iso(),
        }

    def _build_table(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        self.dependencies.sync_snapshot(snapshot)
        game = self.state.get("game")
        return table_view.build_table_view(
            snapshot,
            controlled_seat=int(self.state["controlledSeat"]),
            visible_hands=bool(self.state["visibleHands"]),
            match_id=game.get("matchId") if isinstance(game, dict) else None,
            auto_advance_mode=self._resolve_auto_advance_mode(snapshot),
            result_info=self.build_result_info(snapshot),
        )

    def _build_match_summary(
        self,
        game: dict[str, Any],
        snapshot: dict[str, Any],
    ) -> dict[str, Any]:
        self.dependencies.sync_snapshot(snapshot)
        return table_view.build_match_summary(game, snapshot)

    def _resolve_auto_advance_mode(
        self,
        snapshot: dict[str, Any],
    ) -> str | None:
        self.dependencies.sync_snapshot(snapshot)
        if self.dependencies.is_read_only_game():
            return None
        actor = int(snapshot.get("currentActor", 0))
        controlled_seat = int(self.state.get("controlledSeat", 0))
        phase = snapshot.get("phase")
        if actor == controlled_seat:
            return None
        if phase == "reach_declaration":
            return "ai_think"
        if phase != "discard":
            return None
        riichi_accepted = snapshot.get(
            "riichiAccepted",
            [False, False, False, False],
        )
        if not riichi_accepted[actor]:
            return None
        if (
            self.dependencies.actor_just_drew(snapshot, actor)
            and self.dependencies.can_declare_tsumo(snapshot, actor)
        ):
            return "ai_think"
        if self.dependencies.can_ankan(snapshot, actor):
            return "ai_think"
        return "auto_progress"

    @staticmethod
    def _empty_view() -> dict[str, Any]:
        return {
            "gameId": None,
            "matchId": None,
            "readOnly": False,
            "sourceUrl": None,
            "readOnlyReason": None,
            "currentNodeId": None,
            "nodeComment": "",
            "opponentAnalysis": None,
            "matchSummary": None,
            "table": None,
            "legalActions": [],
            "analysis": None,
            "comparison": None,
            "pendingReview": None,
            "tree": None,
        }
