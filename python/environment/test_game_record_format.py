import copy
import random
import unittest
from unittest.mock import patch

import service
from service_helpers import (
    DORA_INDICATOR_POSITIONS,
    RINSHAN_DRAW_POSITIONS,
    URA_INDICATOR_POSITIONS,
    build_wall,
)


class GameRecordFormatTests(unittest.TestCase):
    def test_new_tsumo_node_uses_the_drawn_tile_instead_of_sorted_hand_order(self):
        game = {"currentNodeId": "parent"}
        with (
            patch.object(service, "draw_tile", return_value="3m"),
            patch.object(service, "persist_snapshot_state"),
            patch.object(service, "create_node", return_value="child") as create_node,
            patch.object(service, "attach_mainline"),
            patch.object(service, "promote_path_to_mainline"),
        ):
            service._create_tsumo_node(game, {"hands": [["C"], [], [], []]}, 0)

        self.assertEqual(create_node.call_args.args[2]["pai"], "3m")

    def test_legacy_tsumo_node_recovers_the_drawn_tile_from_its_snapshot(self):
        game = {
            "nodes": {
                "node": {
                    "action": {"type": "tsumo", "actor": 0, "pai": "C"},
                    "snapshot": {
                        "lastAction": {"type": "tsumo", "actor": 0, "pai": "3m", "source": "wall"},
                    },
                },
            },
        }

        self.assertTrue(service._migrate_tsumo_node_action_tiles(game))
        self.assertEqual(game["nodes"]["node"]["action"]["pai"], "3m")

    def test_legacy_terminal_nodes_keep_pre_settlement_table_scores(self):
        game = {
            "nodes": {
                "before": {
                    "parentId": None,
                    "action": {"type": "dahai"},
                    "snapshot": {"scores": [25000, 25000, 25000, 25000]},
                },
                "hora": {
                    "parentId": "before",
                    "action": {"type": "hora"},
                    "snapshot": {
                        "scores": [33000, 17000, 25000, 25000],
                        "lastAction": {"type": "hora", "deltas": [8000, -8000, 0, 0]},
                    },
                },
                "result": {
                    "parentId": "hora",
                    "action": {
                        "type": "round_result",
                        "result": {
                            "scores": [33000, 17000, 25000, 25000],
                            "eventData": {"deltas": [8000, -8000, 0, 0]},
                        },
                    },
                    "snapshot": {
                        "scores": [33000, 17000, 25000, 25000],
                        "lastAction": {
                            "type": "round_result",
                            "result": {"eventData": {"deltas": [8000, -8000, 0, 0]}},
                        },
                    },
                },
            },
        }

        service._migrate_terminal_table_scores(game)

        self.assertEqual(game["nodes"]["hora"]["snapshot"]["scores"], [25000] * 4)
        self.assertEqual(game["nodes"]["result"]["snapshot"]["scores"], [25000] * 4)
        self.assertEqual(
            game["nodes"]["result"]["snapshot"]["lastAction"]["result"]["scores"],
            [33000, 17000, 25000, 25000],
        )

    def test_legacy_ai_discard_recovers_tsumogiri_from_snapshot(self):
        game = {
            "nodes": {
                "node": {
                    "action": {"type": "dahai", "actor": 2, "pai": "F", "source": "ai"},
                    "snapshot": {
                        "lastAction": {
                            "type": "dahai",
                            "actor": 2,
                            "pai": "F",
                            "tsumogiri": True,
                        },
                    },
                },
            },
        }

        service._migrate_discard_tsumogiri(game)

        self.assertTrue(game["nodes"]["node"]["action"]["tsumogiri"])

    def test_serialized_record_omits_machine_local_runtime_details(self):
        record = service._serialize_game_record_from_parts(
            {"gameId": "test", "nodes": {}},
            {
                "mode": "research",
                "controlledSeat": 2,
                "pendingSeatSwitch": None,
                "visibleHands": True,
                "gameLoaded": True,
                "device": "cuda:0",
            },
        )

        self.assertEqual(record["formatVersion"], 3)
        self.assertNotIn("metadata", record)
        self.assertEqual(
            record["state"],
            {
                "mode": "research",
                "controlledSeat": 2,
                "visibleHands": True,
            },
        )

    def test_read_only_state_remains_in_game_metadata_without_a_redundant_record_type(self):
        record = service._serialize_game_record_from_parts(
            {"metadata": {"readOnly": True}, "nodes": {}},
            {
                "mode": "research",
                "controlledSeat": 0,
                "pendingSeatSwitch": None,
                "visibleHands": False,
            },
        )

        self.assertTrue(record["game"]["metadata"]["readOnly"])
        self.assertNotIn("metadata", record)

    def test_v3_record_uses_one_snapshot_shape_and_reconstructs_runtime_nodes(self):
        game = service.create_empty_game(12345)
        root = game["nodes"]["n_root"]
        start = game["nodes"]["n_1"]
        root["snapshot"]["actionHistory"] = []
        start["snapshot"]["actionHistory"] = [{"type": "start_kyoku"}]
        start["action"]["meta"] = {
            "thinking_time_s": 0.4,
            "engineFingerprint": "sha256:test",
            "source": "local-legal-actions",
        }

        record = service._serialize_game_record_from_parts(
            game,
            {
                "mode": "research",
                "controlledSeat": 0,
                "pendingSeatSwitch": 2,
                "visibleHands": False,
            },
        )

        self.assertEqual(record["formatVersion"], 3)
        self.assertNotIn("pendingSeatSwitch", record["state"])
        self.assertNotIn("treeRevision", record["game"])
        self.assertNotIn("pendingReview", record["game"])
        self.assertIn("roundStateStorage", record["game"])
        for node in record["game"]["nodes"].values():
            for field in ("id", "type", "parentId", "actor", "depth", "isDecision"):
                self.assertNotIn(field, node)
            self.assertNotIn("analysisCache", node)
            self.assertNotIn("matchState", node["snapshot"])
            self.assertNotIn("kyokuState", node["snapshot"])
            self.assertNotIn("actionHistory", node["snapshot"])
        self.assertEqual(
            record["game"]["nodes"]["n_1"]["snapshot"]["actionHistoryDelta"],
            [{"type": "start_kyoku"}],
        )
        self.assertNotIn("meta", record["game"]["nodes"]["n_1"]["action"])

        with patch.object(service, "request_current_shanten_prediction"):
            service.load_game_record(record)
        loaded = service.STATE["game"]
        self.assertEqual(loaded["nodes"]["n_root"]["depth"], 0)
        self.assertEqual(loaded["nodes"]["n_1"]["parentId"], "n_root")
        self.assertEqual(loaded["nodes"]["n_1"]["depth"], 1)
        self.assertEqual(
            loaded["nodes"]["n_1"]["snapshot"]["actionHistory"],
            [{"type": "start_kyoku"}],
        )
        self.assertIn("matchState", loaded["nodes"]["n_1"]["snapshot"])
        self.assertIn("kyokuState", loaded["nodes"]["n_1"]["snapshot"])
        self.assertEqual(
            loaded["nodes"]["n_1"]["snapshot"]["matchState"]["matchType"],
            loaded["matchState"]["matchType"],
        )
        self.assertEqual(
            loaded["nodes"]["n_1"]["snapshot"]["matchState"]["roundSeeds"],
            loaded["matchState"]["roundSeeds"],
        )
        self.assertEqual(service.STATE["pendingSeatSwitch"], None)

        child_id = service.create_node(
            loaded,
            "n_1",
            {"type": "test_transition", "actor": 0},
            copy.deepcopy(loaded["nodes"]["n_1"]["snapshot"]),
        )
        self.assertIn(child_id, loaded["nodes"]["n_1"]["children"])
        self.assertEqual(loaded["nodes"][child_id]["depth"], 2)

    def test_action_history_reset_is_preserved(self):
        game = service.create_empty_game(999)
        game["nodes"]["n_root"]["snapshot"]["actionHistory"] = [{"type": "old"}]
        game["nodes"]["n_1"]["snapshot"]["actionHistory"] = [{"type": "start_kyoku"}]
        record = service._serialize_game_record_from_parts(
            game,
            {
                "mode": "play",
                "controlledSeat": 0,
                "pendingSeatSwitch": None,
                "visibleHands": False,
            },
        )
        stored = record["game"]["nodes"]["n_1"]["snapshot"]
        self.assertTrue(stored["actionHistoryReset"])
        with patch.object(service, "request_current_shanten_prediction"):
            service.load_game_record(record)
        self.assertEqual(
            service.STATE["game"]["nodes"]["n_1"]["snapshot"]["actionHistory"],
            [{"type": "start_kyoku"}],
        )

    def test_complete_round_walls_are_stored_once_and_hydrated(self):
        wall = tuple(build_wall(random.Random(123)))

        def snapshot(live_end, rinshan_drawn):
            rinshan = tuple(wall[index] for index in RINSHAN_DRAW_POSITIONS)[rinshan_drawn:]
            return {
                "fullWall": wall,
                "wall": wall[:live_end],
                "rinshanWall": rinshan,
                "doraIndicatorStack": tuple(wall[index] for index in DORA_INDICATOR_POSITIONS),
                "uraIndicatorStack": tuple(wall[index] for index in URA_INDICATOR_POSITIONS),
                "kyokuState": {
                    "fullWall": wall,
                    "wall": wall[:live_end],
                    "rinshanWall": rinshan,
                },
            }

        game = {
            "gameId": "test",
            "nodes": {
                "a": {"snapshot": snapshot(122, 0)},
                "b": {"snapshot": snapshot(121, 1)},
            },
        }
        record = service._serialize_game_record_from_parts(
            game,
            {
                "mode": "research",
                "controlledSeat": 0,
                "pendingSeatSwitch": None,
                "visibleHands": False,
            },
        )

        stored_game = record["game"]
        self.assertEqual(stored_game["roundWallStorage"]["schemaVersion"], 2)
        self.assertEqual(len(stored_game["roundWallStorage"]["walls"]), 1)
        for node in stored_game["nodes"].values():
            self.assertNotIn("fullWall", node["snapshot"])
            self.assertNotIn("wall", node["snapshot"])
            self.assertIn("wallState", node["snapshot"])

        service._hydrate_round_walls_from_record(stored_game)
        first = stored_game["nodes"]["a"]["snapshot"]
        second = stored_game["nodes"]["b"]["snapshot"]
        self.assertEqual(first["fullWall"], wall)
        self.assertIs(first["fullWall"], second["fullWall"])
        self.assertEqual(len(first["wall"]), 122)
        self.assertEqual(len(second["wall"]), 121)
        self.assertEqual(len(second["rinshanWall"]), 3)

    def test_legacy_round_wall_layout_is_migrated_when_hydrated(self):
        legacy_wall = [f"tile-{index}" for index in range(136)]
        game = {
            "metadata": {},
            "roundWallStorage": {
                "schemaVersion": 1,
                "walls": {"w1": legacy_wall},
            },
            "nodes": {
                "a": {
                    "snapshot": {
                        "wallState": {"ref": "w1", "liveEnd": 122, "rinshanDrawn": 0},
                        "kyokuState": {},
                    },
                },
            },
        }

        service._hydrate_round_walls_from_record(game)

        snapshot = game["nodes"]["a"]["snapshot"]
        self.assertEqual(snapshot["doraIndicatorStack"], tuple(
            legacy_wall[index] for index in service._LEGACY_DORA_INDICATOR_POSITIONS
        ))
        self.assertEqual(snapshot["uraIndicatorStack"], tuple(
            legacy_wall[index] for index in service._LEGACY_URA_INDICATOR_POSITIONS
        ))
        self.assertEqual(snapshot["rinshanWall"], tuple(
            legacy_wall[index] for index in service._LEGACY_RINSHAN_DRAW_POSITIONS
        ))

    def test_legacy_inline_wall_layout_is_migrated_before_resaving(self):
        legacy_wall = tuple(f"tile-{index}" for index in range(136))
        snapshot = {
            "fullWall": legacy_wall,
            "wall": legacy_wall[:122],
            "rinshanWall": tuple(legacy_wall[index] for index in service._LEGACY_RINSHAN_DRAW_POSITIONS),
            "doraIndicatorStack": tuple(
                legacy_wall[index] for index in service._LEGACY_DORA_INDICATOR_POSITIONS
            ),
            "uraIndicatorStack": tuple(
                legacy_wall[index] for index in service._LEGACY_URA_INDICATOR_POSITIONS
            ),
            "kyokuState": {"fullWall": legacy_wall},
        }
        game = {"nodes": {"a": {"snapshot": snapshot}}}

        service._hydrate_round_walls_from_record(game)

        converted = snapshot["fullWall"]
        self.assertEqual(
            tuple(converted[index] for index in DORA_INDICATOR_POSITIONS),
            snapshot["doraIndicatorStack"],
        )
        self.assertEqual(
            tuple(converted[index] for index in URA_INDICATOR_POSITIONS),
            snapshot["uraIndicatorStack"],
        )
        self.assertEqual(
            tuple(converted[index] for index in RINSHAN_DRAW_POSITIONS),
            snapshot["rinshanWall"],
        )
        self.assertIs(snapshot["kyokuState"]["fullWall"], converted)

    def test_incomplete_report_wall_uses_only_a_length_cursor(self):
        game = {
            "gameId": "report",
            "metadata": {"readOnly": True},
            "nodes": {
                "a": {
                    "snapshot": {
                        "fullWall": [],
                        "wall": ["?"] * 122,
                        "rinshanWall": [],
                        "doraIndicatorStack": [],
                        "uraIndicatorStack": [],
                    },
                },
            },
        }
        record = service._serialize_game_record_from_parts(
            game,
            {
                "mode": "research",
                "controlledSeat": 0,
                "pendingSeatSwitch": None,
                "visibleHands": False,
            },
        )
        snapshot = record["game"]["nodes"]["a"]["snapshot"]
        self.assertEqual(snapshot["wallState"], {"incomplete": True, "liveEnd": 122})
        self.assertNotIn("wall", snapshot)

        service._hydrate_round_walls_from_record(record["game"])
        self.assertEqual(len(snapshot["wall"]), 122)
        self.assertEqual(snapshot["fullWall"], ())

    def test_imported_wall_origin_is_kept_with_the_round_snapshot(self):
        previous_game = service.STATE["game"]
        previous_loaded = service.STATE["gameLoaded"]
        previous_next_game_id = service.STATE["nextGameId"]
        try:
            service.STATE["game"] = service.create_empty_game(456789)
            service.STATE["gameLoaded"] = True
            imported_wall = build_wall(random.Random(987))

            node_id = service.reset_current_round_with_full_wall(imported_wall)
            snapshot = service.STATE["game"]["nodes"][node_id]["snapshot"]
            self.assertEqual(snapshot["wallOrigin"], "imported")

            record = service._serialize_game_record_from_parts(
                service.STATE["game"],
                {
                    "mode": "research",
                    "controlledSeat": 0,
                    "pendingSeatSwitch": None,
                    "visibleHands": False,
                },
            )
            stored_snapshot = record["game"]["nodes"][node_id]["snapshot"]
            self.assertEqual(stored_snapshot["wallOrigin"], "imported")
        finally:
            service.STATE["game"] = previous_game
            service.STATE["gameLoaded"] = previous_loaded
            service.STATE["nextGameId"] = previous_next_game_id


if __name__ == "__main__":
    unittest.main()
