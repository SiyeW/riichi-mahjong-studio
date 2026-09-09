"""Commands that advance or edit the currently played hand."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


class GameplayCommands:
    def __init__(
        self,
        state: dict[str, Any],
        *,
        ensure_play_mode: Callable[[], None],
        get_current_snapshot: Callable[[], dict[str, Any]],
        play_prefetch: Any,
        opponent_analysis: Any,
        review_session: Any,
        view_builder: Any,
    ) -> None:
        self._state = state
        self._ensure_play_mode = ensure_play_mode
        self._get_current_snapshot = get_current_snapshot
        self._play_prefetch = play_prefetch
        self._opponent_analysis = opponent_analysis
        self._review_session = review_session
        self._view_builder = view_builder

    def advance(self, request_id: Any, command: str) -> dict[str, Any]:
        self._ensure_play_mode()
        game = self._state["game"]
        if game.get("pendingReview"):
            return self._view_builder.build_response(request_id, command)
        play_prefetch = self._play_prefetch.advance_game(game)
        if self._state.get("gameLoaded") and self._state.get("mode") == "research":
            self._opponent_analysis.request_current(self._get_current_snapshot())
        return self._view_builder.build_response(
            request_id,
            command,
            {"playPrefetch": play_prefetch},
        )

    def submit(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        self._ensure_play_mode()
        self._play_prefetch.cancel()
        action_type = payload.get("type")
        game = self._state["game"]
        if not game:
            raise ValueError("No active game.")
        snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
        phase = snapshot["phase"]

        if phase == "discard":
            self._submit_discard_phase(snapshot, action_type, payload)
        elif phase == "reach_declaration":
            if action_type != "dahai":
                raise ValueError(
                    f"Unsupported reach-declaration-phase action type: {action_type}"
                )
            self._review_session.submit_riichi_discard(
                str(payload.get("pai") or ""),
                payload.get("fromDrawn"),
            )
        elif phase in ("reaction_window", "kan_reaction_window"):
            if action_type == "dahai":
                return self._view_builder.build_response(request_id, command)
            self._review_session.submit_reaction(
                str(action_type or ""),
                str(payload.get("variant") or "") or None,
                str(payload.get("candidateId") or "") or None,
            )
        else:
            raise ValueError(
                f"Unsupported action phase for submit_user_action: {phase}"
            )

        play_prefetch = self._play_prefetch.start()
        return self._view_builder.build_response(
            request_id,
            command,
            {"playPrefetch": play_prefetch},
        )

    def confirm_pending_review(
        self,
        request_id: Any,
        command: str,
    ) -> dict[str, Any]:
        self._ensure_play_mode()
        self._play_prefetch.cancel()
        self._review_session.finalize(confirm_proposed=True)
        play_prefetch = self._play_prefetch.start()
        return self._view_builder.build_response(
            request_id,
            command,
            {"playPrefetch": play_prefetch},
        )

    def _submit_discard_phase(
        self,
        snapshot: dict[str, Any],
        action_type: Any,
        payload: dict[str, Any],
    ) -> None:
        if action_type == "dahai":
            self._review_session.submit_discard(
                str(payload.get("pai") or ""),
                payload.get("fromDrawn"),
            )
        elif action_type == "hora":
            self._review_session.submit_self_hora()
        elif action_type in ("ankan", "kakan"):
            self._review_session.submit_self_kan(
                str(payload.get("variant") or action_type)
            )
        elif action_type == "reach":
            self._review_session.toggle_riichi()
        elif action_type == "ryukyoku":
            self._review_session.submit_abortive_draw(
                str(payload.get("variant") or "")
            )
        elif action_type == "none":
            if snapshot.get("riichiDiscardState") != "ankan_choice":
                raise ValueError("Skip is only legal during riichi ankan choice.")
            self._review_session.submit_riichi_ankan_skip()
        else:
            raise ValueError(
                f"Unsupported discard-phase action type: {action_type}"
            )
