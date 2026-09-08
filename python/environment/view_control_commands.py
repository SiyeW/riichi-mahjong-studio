"""Commands that change the active seat, mode, or analysis visibility."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


class ViewControlCommands:
    def __init__(
        self,
        state: dict[str, Any],
        *,
        auto_analysis: Any,
        play_prefetch: Any,
        opponent_analysis: Any,
        opponent_predictions: Any,
        decision_analysis: Any,
        review_session: Any,
        game_flow: Any,
        view_builder: Any,
        ensure_loaded: Callable[[], None],
        is_read_only: Callable[[], bool],
        normalize_mode: Callable[[Any], str],
        normalize_seat: Callable[[Any], int],
        get_current_snapshot: Callable[[], dict[str, Any]],
    ) -> None:
        self._state = state
        self._auto_analysis = auto_analysis
        self._play_prefetch = play_prefetch
        self._opponent_analysis = opponent_analysis
        self._opponent_predictions = opponent_predictions
        self._decision_analysis = decision_analysis
        self._review_session = review_session
        self._game_flow = game_flow
        self._view_builder = view_builder
        self._ensure_loaded = ensure_loaded
        self._is_read_only = is_read_only
        self._normalize_mode = normalize_mode
        self._normalize_seat = normalize_seat
        self._get_current_snapshot = get_current_snapshot

    def set_mode(self, request_id: Any, command: str, payload: dict[str, Any]) -> dict[str, Any]:
        self._ensure_loaded()
        next_mode = self._normalize_mode(payload.get("mode"))
        if next_mode == "play" and self._is_read_only():
            raise ValueError(
                "This replay has no complete wall and cannot enter play mode."
            )
        self._play_prefetch.cancel()
        self._state["mode"] = next_mode
        if self._state["gameLoaded"] and next_mode == "research":
            self._opponent_analysis.request_current(self._get_current_snapshot())
        elif self._state["gameLoaded"] and next_mode == "play":
            self._play_prefetch.start()
        return self._view_builder.build_response(request_id, command)

    def set_analysis_visibility(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        if "decisionRecommendations" in payload:
            enabled = bool(payload.get("decisionRecommendations"))
            self._state["decisionRecommendationsEnabled"] = enabled
            if not enabled:
                self._decision_analysis.cancel_pending()
                game = self._state.get("game")
                if isinstance(game, dict) and game.get("pendingReview"):
                    self._review_session.finalize(confirm_proposed=True)
        if "opponentAnalysis" in payload:
            enabled = bool(payload.get("opponentAnalysis"))
            self._state["opponentAnalysisEnabled"] = enabled
            if enabled and self._state.get("gameLoaded"):
                self._opponent_analysis.request_current(self._get_current_snapshot())
            elif not enabled:
                self._opponent_predictions.cancel_pending()
        if self._state.get("mode") == "play" and self._state.get("gameLoaded"):
            self._play_prefetch.start()
        return self._view_builder.build_response(request_id, command)

    def request_seat_switch(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        seat = self._normalize_seat(payload.get("seat"))
        self._auto_analysis.cancel("主视角已切换")
        self._play_prefetch.cancel()
        self._state["pendingSeatSwitch"] = seat
        if self._state["gameLoaded"] and self._state["mode"] == "play":
            self._game_flow.advance(self._state["game"])
            self._normalize_tree_cursor()
        elif self._state["mode"] != "play":
            snapshot = self._get_current_snapshot() if self._state["gameLoaded"] else {}
            self.apply_pending_seat_switch(snapshot)
            if self._state["gameLoaded"]:
                self._normalize_tree_cursor()
                self._opponent_analysis.request_current(self._get_current_snapshot())
        elif self._state["gameLoaded"]:
            self._play_prefetch.start()
        return self._view_builder.build_response(request_id, command)

    def toggle_visible_hands(self, request_id: Any, command: str) -> dict[str, Any]:
        self._state["visibleHands"] = not self._state["visibleHands"]
        if self._state["gameLoaded"] and self._state["mode"] == "research":
            self._opponent_analysis.request_current(self._get_current_snapshot())
        return self._view_builder.build_response(request_id, command)

    def apply_pending_seat_switch(self, _snapshot: dict[str, Any]) -> bool:
        pending_seat = self._state.get("pendingSeatSwitch")
        if pending_seat is None:
            return False
        self._state["controlledSeat"] = pending_seat
        self._state["pendingSeatSwitch"] = None
        return True

    def _normalize_tree_cursor(self) -> None:
        self._view_builder.normalize_tree_cursor(
            self._state["game"], self._state["controlledSeat"]
        )
