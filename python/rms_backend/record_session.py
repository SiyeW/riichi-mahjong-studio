"""Game record lifecycle and serialization for the backend service."""

from __future__ import annotations

import copy
import random
from dataclasses import dataclass
from typing import Any, Callable, MutableMapping

from . import game_tree
from . import snapshot_state
from . import tree_view
from .analysis_cache import migrate_analysis_cache_storage
from .custom_tenhou import (
    build_custom_tenhou_game,
    export_custom_tenhou,
    normalize_custom_tenhou_input,
)
from .game_record_storage import (
    hydrate_game_structure,
    hydrate_round_walls,
    migrate_discard_tsumogiri,
    migrate_terminal_table_scores,
    repair_tsumo_action_tiles,
    serialize_game_record_parts,
)
from .mortal_report_import import (
    attach_mortal_review_cache,
    build_mortal_report_game,
    repair_mortal_report_game,
)
from .service_helpers import build_round_seed_stream, now_iso
from .wall_reconstruction import reconstruct_imported_walls


State = MutableMapping[str, Any]
Game = dict[str, Any]


@dataclass
class RecordSessionDependencies:
    """Narrow service operations required at record lifecycle boundaries."""

    reset_runtime: Callable[[], None]
    create_empty_game: Callable[[int], Game]
    advance_to_next_user_turn: Callable[[Game], None]
    prewarm_action_engine: Callable[[int], None]
    repair_reaction_decisions: Callable[[Game], None]
    backfill_child_comparisons: Callable[[Game], None]
    update_child_comparisons: Callable[[Game, dict, Any, int], None]
    current_snapshot: Callable[[], dict]
    request_opponent_analysis: Callable[..., Any]
    purge_mjai_cache: Callable[[str], None]
    invalidate_auto_timeline: Callable[[], None]


class RecordSession:
    """Owns replacing, importing, exporting, and closing the active record."""

    _STATE_FIELDS = (
        "game",
        "gameLoaded",
        "mode",
        "controlledSeat",
        "pendingSeatSwitch",
        "visibleHands",
    )

    def __init__(self, state: State, dependencies: RecordSessionDependencies):
        self._state = state
        self.dependencies = dependencies

    def ensure_loaded(self) -> None:
        if not self._state["gameLoaded"] or not self._state["game"]:
            raise ValueError("No active game is loaded.")

    @staticmethod
    def is_read_only(game: Game | None) -> bool:
        metadata = game.get("metadata") if isinstance(game, dict) else None
        return bool(isinstance(metadata, dict) and metadata.get("readOnly"))

    @staticmethod
    def normalize_mode(value: Any) -> str:
        return "research" if value == "research" else "play"

    @staticmethod
    def normalize_seat(value: Any) -> int:
        seat = int(value)
        if seat < 0 or seat > 3:
            raise ValueError("Seat must be between 0 and 3.")
        return seat

    def serialize(self) -> dict:
        self.ensure_loaded()
        game_copy = copy.deepcopy(self._state["game"])
        state_copy = {
            "mode": self._state["mode"],
            "controlledSeat": self._state["controlledSeat"],
            "pendingSeatSwitch": self._state["pendingSeatSwitch"],
            "visibleHands": self._state["visibleHands"],
        }
        return serialize_game_record_parts(game_copy, state_copy)

    def load(self, record: Any) -> None:
        if not isinstance(record, dict):
            raise ValueError("Record must be an object.")
        format_version = int(record.get("formatVersion") or 0)
        if format_version not in (1, 2, 3):
            raise ValueError("Unsupported record format version.")
        game = record.get("game")
        state = record.get("state") or {}
        if not isinstance(game, dict) or not game.get("nodes"):
            raise ValueError("Record is missing game data.")

        hydrate_game_structure(game, format_version)
        hydrate_round_walls(game)
        self._hydrate_match_state(game)
        game.setdefault("pendingReview", None)
        game.setdefault("treeRevision", 1)
        repair_mortal_report_game(game)
        repair_tsumo_action_tiles(game)
        self.dependencies.repair_reaction_decisions(game)
        if game_tree.repair_main_branch_links(game):
            game["treeRevision"] = int(game.get("treeRevision", 0)) + 1
        migrate_analysis_cache_storage(game)
        self._synchronize_snapshots(game)
        migrate_discard_tsumogiri(game)
        migrate_terminal_table_scores(game)

        candidate = copy.deepcopy(game)
        mode = "research" if self.is_read_only(game) else self.normalize_mode(state.get("mode"))
        controlled_seat = self.normalize_seat(state.get("controlledSeat", 0))
        visible_hands = bool(state.get("visibleHands"))
        previous = self._state_snapshot()
        self.dependencies.reset_runtime()
        try:
            self._reserve_game_id(candidate.get("gameId"))
            self._state.update({
                "game": candidate,
                "gameLoaded": True,
                "mode": mode,
                "controlledSeat": controlled_seat,
                "pendingSeatSwitch": None,
                "visibleHands": visible_hands,
            })
            tree_view.normalize_current_cursor(candidate, controlled_seat)
            self.dependencies.backfill_child_comparisons(candidate)
            if mode == "research":
                self.dependencies.request_opponent_analysis()
        except Exception:
            self._restore_after_failure(previous)
            raise

    def create(self) -> None:
        seed = random.randint(100000, 999999)
        controlled_seat = random.randint(0, 3)
        game = self.dependencies.create_empty_game(seed)
        previous = self._state_snapshot()
        self.dependencies.reset_runtime()
        try:
            self._state.update({
                "controlledSeat": controlled_seat,
                "pendingSeatSwitch": None,
                "game": game,
                "gameLoaded": True,
                "mode": "play",
            })
            self.dependencies.advance_to_next_user_turn(game)
            self.dependencies.prewarm_action_engine(controlled_seat)
        except Exception:
            self._restore_after_failure(previous)
            raise

    def close(self) -> None:
        self.dependencies.reset_runtime()
        self._state.update({
            "game": None,
            "gameLoaded": False,
            "mode": "play",
            "pendingSeatSwitch": None,
            "visibleHands": False,
        })

    def import_mortal(
        self,
        report: Any,
        source_url: Any,
        source_import_url: Any = None,
        reconstruct_walls: bool = False,
        seed: Any = None,
    ) -> Any:
        game_id = self._next_game_id()
        game, controlled_seat = build_mortal_report_game(
            report,
            str(source_url or ""),
            game_id,
            now_iso(),
        )
        official_analyses = attach_mortal_review_cache(game, report, controlled_seat)
        self.dependencies.repair_reaction_decisions(game)
        for node_id, analysis in official_analyses.items():
            node = game.get("nodes", {}).get(node_id)
            if isinstance(node, dict):
                self.dependencies.update_child_comparisons(game, node, analysis, controlled_seat)
        game.setdefault("treeRevision", 1)
        game["metadata"]["sourceImportUrl"] = str(source_import_url or source_url or "")
        reconstruction = reconstruct_imported_walls(game, seed, generated_at=now_iso()) if reconstruct_walls else None
        self._activate_imported(game, controlled_seat)
        return reconstruction

    def import_custom(self, raw_input: Any, reconstruct_walls: bool = False, seed: Any = None) -> Any:
        document = normalize_custom_tenhou_input(raw_input)
        game, controlled_seat = build_custom_tenhou_game(document, self._next_game_id(), now_iso())
        self.dependencies.repair_reaction_decisions(game)
        game.setdefault("treeRevision", 1)
        reconstruction = reconstruct_imported_walls(game, seed, generated_at=now_iso()) if reconstruct_walls else None
        self._activate_imported(game, controlled_seat)
        return reconstruction

    def export_custom(self) -> dict:
        self.ensure_loaded()
        return export_custom_tenhou(self._state["game"])

    def reconstruct_walls(self, seed: Any = None) -> dict:
        self.ensure_loaded()
        game = self._state["game"]
        if not self.is_read_only(game):
            raise ValueError("当前牌谱已经有完整牌山。")
        result = reconstruct_imported_walls(game, seed, generated_at=now_iso())
        game.setdefault("treeRevision", 1)
        self.dependencies.purge_mjai_cache(game["gameId"])
        self.dependencies.invalidate_auto_timeline()
        return result

    def _activate_imported(self, game: Game, controlled_seat: int) -> None:
        previous = self._state_snapshot()
        self.dependencies.reset_runtime()
        try:
            self._state.update({
                "game": game,
                "gameLoaded": True,
                "mode": "research",
                "controlledSeat": controlled_seat,
                "pendingSeatSwitch": None,
                "visibleHands": False,
            })
            self.dependencies.request_opponent_analysis(self.dependencies.current_snapshot())
        except Exception:
            self._restore_after_failure(previous)
            raise

    @staticmethod
    def _hydrate_match_state(game: Game) -> None:
        game.setdefault("matchId", game.get("gameId", "game"))
        game.setdefault("metadata", {"label": game["matchId"], "source": "imported-record"})
        game.setdefault("matchConfig", {
            "matchType": "hanchan",
            "players": 4,
            "westEntryEnabled": True,
            "maxBakaze": "W",
            "maxKyoku": 4,
        })
        if "matchState" in game:
            return
        root_snapshot = next(iter(game["nodes"].values()))["snapshot"]
        snapshot_state.sync(root_snapshot)
        game["matchState"] = copy.deepcopy(root_snapshot["matchState"])
        game["matchState"].update({"matchId": game["matchId"], "seed": game.get("seed", 0)})
        game["matchState"].setdefault("matchType", "hanchan")
        game["matchState"].setdefault("players", 4)
        game["matchState"].setdefault("westEntryEnabled", True)
        game["matchState"].setdefault("maxBakaze", "W")
        game["matchState"].setdefault("maxKyoku", 4)
        game["matchState"].setdefault(
            "roundSeeds",
            build_round_seed_stream(random.Random(int(game.get("seed", 0)))),
        )

    @staticmethod
    def _synchronize_snapshots(game: Game) -> None:
        static_fields = (
            "matchId", "matchType", "players", "westEntryEnabled",
            "maxBakaze", "maxKyoku", "seed", "roundSeeds",
        )
        for node in game["nodes"].values():
            snapshot = node["snapshot"]
            snapshot_state.sync(snapshot)
            for field in static_fields:
                if field in game["matchState"]:
                    snapshot["matchState"][field] = copy.deepcopy(game["matchState"][field])

    def _state_snapshot(self) -> dict:
        return {key: self._state[key] for key in self._STATE_FIELDS}

    def _restore_after_failure(self, previous: dict) -> None:
        try:
            self.dependencies.reset_runtime()
        finally:
            self._state.update(previous)

    def _next_game_id(self) -> str:
        game_id = f"game_{self._state['nextGameId']:04d}"
        self._state["nextGameId"] += 1
        return game_id

    def _reserve_game_id(self, game_id: Any) -> None:
        text = str(game_id or "")
        if text.startswith("game_") and text[5:].isdigit():
            self._state["nextGameId"] = max(self._state["nextGameId"], int(text[5:]) + 1)
