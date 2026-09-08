"""Commands for analysis sessions, caches, and diagnostic payloads."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


class AnalysisCommands:
    def __init__(
        self,
        *,
        auto_analysis: Any,
        engine_management: Any,
        opponent_analysis: Any,
        view_builder: Any,
        clear_caches: Callable[[], dict[str, Any]],
        get_action_debug: Callable[[], Any],
        get_opponent_debug: Callable[[], Any],
        now_iso: Callable[[], str],
    ) -> None:
        self._auto_analysis = auto_analysis
        self._engine_management = engine_management
        self._opponent_analysis = opponent_analysis
        self._view_builder = view_builder
        self._clear_caches = clear_caches
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
            "cleared": self._clear_caches(),
            "timestamp": self._now_iso(),
        }
