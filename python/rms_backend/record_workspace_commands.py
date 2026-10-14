"""Commands for records, authored metadata, branches, and reconstructed walls."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .record_file import read_record_file, RecordFileWriter


class RecordWorkspaceCommands:
    def __init__(
        self,
        state: dict[str, Any],
        *,
        record_session: Any,
        record_commands: Any,
        play_prefetch: Any,
        view_builder: Any,
        ensure_loaded: Callable[[], None],
        ensure_writable: Callable[[], None],
        get_wall_view: Callable[[dict[str, Any]], list[str]],
        reset_round_wall: Callable[[list[str]], str],
        now_iso: Callable[[], str],
    ) -> None:
        self._state = state
        self._record_session = record_session
        self._record_commands = record_commands
        self._play_prefetch = play_prefetch
        self._view_builder = view_builder
        self._ensure_loaded = ensure_loaded
        self._ensure_writable = ensure_writable
        self._get_wall_view = get_wall_view
        self._reset_round_wall = reset_round_wall
        self._now_iso = now_iso

    def create(self, request_id: Any, command: str) -> dict[str, Any]:
        self._record_session.create()
        return self._view_builder.build_response(
            request_id,
            command,
            {"playPrefetch": self._play_prefetch.start()},
        )

    def close(self, request_id: Any, command: str) -> dict[str, Any]:
        self._record_session.close()
        return self._view_builder.build_response(request_id, command)

    def import_mortal(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        reconstruction = self._record_session.import_mortal(
            payload.get("report"),
            payload.get("sourceUrl"),
            payload.get("sourceImportUrl"),
            bool(payload.get("reconstructWalls")),
            payload.get("seed"),
        )
        return self._reconstruction_response(request_id, command, reconstruction)

    def import_custom(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        reconstruction = self._record_session.import_custom(
            payload.get("input"),
            bool(payload.get("reconstructWalls")),
            payload.get("seed"),
        )
        return self._reconstruction_response(request_id, command, reconstruction)

    def export_custom(self, request_id: Any, command: str) -> dict[str, Any]:
        return self._view_builder.build_response(
            request_id,
            command,
            {"customTenhou": self._record_session.export_custom()},
        )

    def import_file(self, request_id: Any, command: str, payload: dict[str, Any]) -> dict[str, Any]:
        reconstruction = self._record_session.import_file(
            payload.get('path'), bool(payload.get('reconstructWalls')), payload.get('seed'),
        )
        return self._reconstruction_response(request_id, command, reconstruction)

    def set_player_name(self, request_id: Any, command: str, payload: dict[str, Any]) -> dict[str, Any]:
        changed, name = self._record_commands.set_player_name(payload.get('seat'), payload.get('name'))
        return {
            'request_id': request_id,
            'command': command,
            'changed': changed,
            'seat': payload.get('seat'),
            'name': name,
            'timestamp': self._now_iso(),
        }

    def import_record(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        return self.activate_import(request_id, command, self.prepare_import(payload))

    def prepare_import(self, payload):
        if "path" in payload and "record" in payload:
            raise ValueError("Supply either a record file path or a record, not both.")
        writer = RecordFileWriter()
        record = read_record_file(payload["path"], writer=writer) if "path" in payload else payload.get("record")
        prepared = self._record_session.prepare_load(record, take_ownership=True, file_writer=writer)
        return prepared, record.get('metadata') or {}

    def activate_import(self, request_id, command, candidate):
        prepared, metadata = candidate
        self._record_session.activate_load(prepared)
        return self._view_builder.build_response(request_id, command, {
            "recordMetadata": metadata,
        })

    def jump(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        if 'navigationIntent' in payload:
            intent = payload['navigationIntent']
            if not isinstance(intent, int) or isinstance(intent, bool) or intent < 0:
                raise ValueError('Navigation intent must be a nonnegative integer.')
        stayed_in_round = self._record_commands.jump(
            str(payload.get("nodeId") or "")
        )
        if 'navigationIntent' in payload:
            self._view_builder.begin_visit(payload['navigationIntent'])
        try:
            client_tree_revision = int(payload.get("treeRevision"))
        except (TypeError, ValueError):
            client_tree_revision = None
        tree_is_current = client_tree_revision == int(
            self._state["game"].get("treeRevision", 0)
        )
        return self._view_builder.build_response(
            request_id,
            command,
            compact_tree=stayed_in_round and tree_is_current,
        )

    def set_main_branch(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        self._record_commands.set_main_branch(str(payload.get("nodeId") or ""))
        return self._view_builder.build_response(request_id, command)

    def set_comment(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        node_id = str(payload.get("nodeId") or "")
        changed, comment = self._record_commands.set_comment(
            node_id,
            payload.get("comment"),
        )
        return {
            "request_id": request_id,
            "command": command,
            "nodeId": node_id,
            "comment": comment,
            "changed": changed,
            "timestamp": self._now_iso(),
        }

    def delete(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        deleted_count = self._record_commands.delete(
            str(payload.get("nodeId") or "")
        )
        return self._view_builder.build_response(
            request_id,
            command,
            {"deletedCount": deleted_count},
        )

    def get_wall(self, request_id: Any, command: str) -> dict[str, Any]:
        self._ensure_loaded()
        game = self._state["game"]
        snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
        metadata = game.get("metadata") or {}
        tiles = self._get_wall_view(snapshot)
        reconstruction = metadata.get("wallReconstruction") or {}
        return {
            "request_id": request_id,
            "command": command,
            "tiles": tiles,
            "complete": len(tiles) == 136,
            "canReconstruct": bool(
                metadata.get("source") in ("mortal-report", "tenhou-custom", "mjai")
                and metadata.get("readOnly")
            ),
            "seed": (
                reconstruction.get("seed")
                if reconstruction
                else game.get("seed") if len(tiles) == 136 else None
            ),
            "origin": str(
                snapshot.get("wallOrigin")
                or ("reconstructed" if reconstruction else "generated")
            ),
            "sourceUrl": metadata.get("sourceImportUrl")
            or metadata.get("sourceUrl"),
            "timestamp": self._now_iso(),
        }

    def reconstruct_walls(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        reconstruction = self._record_session.reconstruct_walls(
            payload.get("seed")
        )
        return self._reconstruction_response(request_id, command, reconstruction)

    def import_wall(
        self,
        request_id: Any,
        command: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        self._ensure_writable()
        self._reset_round_wall(payload.get("tiles"))
        return self._view_builder.build_response(request_id, command)

    def _reconstruction_response(
        self,
        request_id: Any,
        command: str,
        reconstruction: Any,
    ) -> dict[str, Any]:
        return self._view_builder.build_response(
            request_id,
            command,
            {"reconstruction": reconstruction},
        )
