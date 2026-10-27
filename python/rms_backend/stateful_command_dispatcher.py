"""Route serialized stateful commands to their owning domain command object."""

from __future__ import annotations

from collections.abc import Callable
from contextlib import nullcontext
from threading import RLock
from typing import Any


class StatefulCommandDispatcher:
    def __init__(
        self,
        *,
        state_lock: RLock,
        configure_thinking_time: Callable[[], None],
        run_debug_scenario: Callable[[str], bool],
        view_builder: Any,
        analysis_commands: Any,
        record_commands: Any,
        view_control_commands: Any,
        gameplay_commands: Any,
        capture_mutation: Callable[..., Any] | None = None,
        prepare_analysis_use: Callable[[], Any] = lambda: None,
        use_prepared_analysis: Callable[..., Any] = lambda prepared: nullcontext(),
        validate_record_scope: Callable[..., None] = lambda command, data: None,
    ) -> None:
        self._state_lock = state_lock
        self._configure_thinking_time = configure_thinking_time
        self._run_debug_scenario = run_debug_scenario
        self._view_builder = view_builder
        self._analysis = analysis_commands
        self._record = record_commands
        self._view_control = view_control_commands
        self._gameplay = gameplay_commands
        self._capture_mutation = capture_mutation or (lambda command, payload: nullcontext())
        self._prepare_analysis_use, self._use_prepared_analysis = prepare_analysis_use, use_prepared_analysis
        self.validate_record_scope = validate_record_scope

    def dispatch(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any] | None,
    ) -> dict[str, Any]:
        data = payload or {}
        if command == 'create_game':
            prepared = self._record.prepare_create()
            with self._state_lock:
                self._configure_thinking_time()
                return self._record.activate_created(request_id, command, prepared)
        if command == 'import_game_record':
            # The command executor serializes record edits, but candidate file
            # I/O/legacy hydration must not exclude status, inference completion
            # or other owners merely because they also use the game-state lock.
            prepared = self._record.prepare_import(data)
            with self._state_lock:
                self._configure_thinking_time()
                return self._record.activate_import(request_id, command, prepared)
        if command in ('import_mortal_report', 'import_custom_tenhou', 'import_replay_file'):
            prepared = self._record.prepare_reconstruction(command, data)
            with self._state_lock:
                self._configure_thinking_time()
                return self._record.activate_reconstruction(request_id, command, prepared)
        if command == 'submit_user_action':
            with self._state_lock:
                prepared = self._prepare_analysis_use()
            if prepared is not None:
                try:
                    prepared.load()  # Requested policy only; never I/O/codec waits under the game lock.
                    with self._state_lock, self._use_prepared_analysis(prepared), self._capture_mutation(command, data):
                        return self._dispatch_locked(request_id, command, data)
                finally:
                    prepared.close()
        with self._state_lock, self._capture_mutation(command, data):
            return self._dispatch_locked(request_id, command, data)

    def _dispatch_locked(self, request_id, command, data):
        self.validate_record_scope(command, data)
        self._configure_thinking_time()
        if self._run_debug_scenario(command):
            return self._view_builder.build_response(request_id, command)
        handler = self._handlers(request_id, command, data).get(command)
        if handler is None:
            raise ValueError(f"Unsupported command: {command}")
        return handler()

    def _handlers(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
    ) -> dict[str, Callable[[], dict[str, Any]]]:
        response = self._view_builder.build_response
        return {
            "get_status": lambda: self._view_builder.build_status_response(request_id),
            "get_game_view": lambda: response(request_id, command),
            "start_auto_analysis": lambda: self._analysis.start_auto(
                request_id, command
            ),
            "cancel_auto_analysis": lambda: self._analysis.cancel_auto(
                request_id, command
            ),
            "describe_engine": lambda: self._analysis.describe(
                request_id, command, payload
            ),
            "get_analysis": lambda: self._analysis.current_opponent_analysis(
                request_id, command
            ),
            "clear_analysis_caches": lambda: self._analysis.clear_caches(
                request_id, command
            ),
            "close_game": lambda: self._record.close(request_id, command),
            "set_player_name": lambda: self._record.set_player_name(request_id, command, payload),
            "export_custom_tenhou": lambda: self._record.export_custom(
                request_id, command
            ),
            "jump_to_node": lambda: self._record.jump(
                request_id, command, payload
            ),
            "set_main_branch": lambda: self._record.set_main_branch(
                request_id, command, payload
            ),
            "set_node_comment": lambda: self._record.set_comment(
                request_id, command, payload
            ),
            "delete_node": lambda: self._record.delete(
                request_id, command, payload
            ),
            "get_wall_view": lambda: self._record.get_wall(request_id, command),
            "reconstruct_walls": lambda: self._record.reconstruct_walls(
                request_id, command, payload
            ),
            "import_wall": lambda: self._record.import_wall(
                request_id, command, payload
            ),
            "set_mode": lambda: self._view_control.set_mode(
                request_id, command, payload
            ),
            "set_analysis_visibility": lambda: (
                self._view_control.set_analysis_visibility(
                    request_id, command, payload
                )
            ),
            "request_seat_switch": lambda: self._view_control.request_seat_switch(
                request_id, command, payload
            ),
            "toggle_visible_hands": lambda: (
                self._view_control.toggle_visible_hands(request_id, command)
            ),
            "advance_game": lambda: self._gameplay.advance(request_id, command),
            "submit_user_action": lambda: self._gameplay.submit(
                request_id, command, payload
            ),
            "confirm_pending_review": lambda: self._gameplay.confirm_pending_review(
                request_id, command
            ),
        }
