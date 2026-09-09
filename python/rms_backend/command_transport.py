"""Transport-level command routing around the stateful environment dispatcher."""

from __future__ import annotations

from collections.abc import Callable
from threading import RLock
from typing import Any


class CommandTransport:
    """Handle lock-free service commands and emit exactly one response."""

    def __init__(
        self,
        *,
        state_lock: RLock,
        view_builder: Any,
        engine_management: Any,
        collect_runtime_metrics: Callable[[], dict[str, int]],
        dispatch_stateful: Callable[[Any, str, dict[str, Any]], dict[str, Any]],
        emit: Callable[[dict[str, Any]], None],
        now_iso: Callable[[], str],
    ) -> None:
        self._state_lock = state_lock
        self._view_builder = view_builder
        self._engine_management = engine_management
        self._collect_runtime_metrics = collect_runtime_metrics
        self._dispatch_stateful = dispatch_stateful
        self._emit = emit
        self._now_iso = now_iso

    def process(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any] | None,
        *,
        lightweight_status: bool = False,
    ) -> None:
        try:
            response = self._build_response(
                request_id,
                command,
                payload or {},
                lightweight_status=lightweight_status,
            )
            self._emit(response)
        except Exception as error:  # pylint: disable=broad-except
            self._emit(
                {
                    "request_id": request_id,
                    "command": command,
                    "error": str(error),
                    "timestamp": self._now_iso(),
                }
            )

    def _build_response(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
        *,
        lightweight_status: bool,
    ) -> dict[str, Any]:
        if lightweight_status:
            return self._view_builder.build_status_response(request_id)
        if command == "get_runtime_metrics":
            return {
                "request_id": request_id,
                "command": command,
                "metrics": self._collect_runtime_metrics(),
                "timestamp": self._now_iso(),
            }
        if command == "describe_engine":
            return {
                "request_id": request_id,
                "command": command,
                "description": self._engine_management.describe(payload),
                "timestamp": self._now_iso(),
            }
        if command == "reload_engines":
            result = self._engine_management.reload(
                str(payload.get("profileId") or "")
            )
            with self._state_lock:
                return self._view_builder.build_response(
                    request_id,
                    command,
                    {"reload": result},
                )
        if command == "unload_engine":
            return {
                "request_id": request_id,
                "command": command,
                "state": self._engine_management.unload(
                    payload.get("kind"),
                    payload.get("profileId"),
                ),
                "timestamp": self._now_iso(),
            }
        return self._dispatch_stateful(request_id, command, payload)
