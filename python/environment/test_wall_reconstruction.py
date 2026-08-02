from __future__ import annotations

import copy
import random
import unittest
from collections import Counter

from mortal_report_import import build_mortal_report_game
from service_helpers import build_wall
from wall_reconstruction import (
    DORA_POSITIONS,
    RINSHAN_DRAW_POSITIONS,
    URA_POSITIONS,
    reconstruct_imported_walls,
)


class _NoShuffle:
    def shuffle(self, values):
        return None


def _ordered_tile_set():
    result = []
    for suit in ("m", "p", "s"):
        for number in range(1, 10):
            tile = f"{number}{suit}"
            result.extend((f"5{suit}r", tile, tile, tile) if number == 5 else (tile,) * 4)
    for tile in ("E", "S", "W", "N", "P", "F", "C"):
        result.extend((tile,) * 4)
    return result


def _report_from_wall(wall):
    hands = [wall[seat * 13:(seat + 1) * 13] for seat in range(4)]
    return {
        "player_id": 0,
        "game_length": "Tonpuusen",
        "mjai_log": [
            {"type": "start_game", "names": ["A", "B", "C", "D"]},
            {
                "type": "start_kyoku",
                "bakaze": "E",
                "kyoku": 1,
                "honba": 0,
                "kyotaku": 0,
                "oya": 0,
                "scores": [25000] * 4,
                "dora_marker": wall[DORA_POSITIONS[0]],
                "tehais": hands,
            },
            {"type": "tsumo", "actor": 0, "pai": wall[52]},
            {"type": "dahai", "actor": 0, "pai": wall[52], "tsumogiri": True},
            {"type": "ankan", "actor": 1, "consumed": ["1m"] * 4},
            {"type": "dora", "dora_marker": wall[DORA_POSITIONS[1]]},
            {"type": "tsumo", "actor": 1, "pai": wall[RINSHAN_DRAW_POSITIONS[0]]},
            {"type": "ryukyoku", "deltas": [0, 0, 0, 0]},
            {"type": "end_kyoku"},
            {"type": "end_game"},
        ],
        "split_logs": [],
    }


class WallGenerationTests(unittest.TestCase):
    def test_wall_sections_use_majsoul_display_positions(self):
        self.assertEqual(RINSHAN_DRAW_POSITIONS, (135, 134, 133, 132))
        self.assertEqual(DORA_POSITIONS, (131, 129, 127, 125, 123))
        self.assertEqual(URA_POSITIONS, (130, 128, 126, 124, 122))

    def test_wall_is_stored_directly_in_application_physical_order(self):
        sequence = _ordered_tile_set()
        wall = build_wall(_NoShuffle())

        self.assertEqual(wall, sequence)
        self.assertEqual(len(wall[:52]), 52)
        self.assertEqual(len(wall[52:122]), 70)
        self.assertEqual(len(wall[122:]), 14)
        self.assertEqual(len([wall[index] for index in RINSHAN_DRAW_POSITIONS]), 4)
        self.assertEqual(len([wall[index] for index in DORA_POSITIONS]), 5)
        self.assertEqual(len([wall[index] for index in URA_POSITIONS]), 5)


class ImportedWallReconstructionTests(unittest.TestCase):
    def _build_game(self, wall):
        game, _ = build_mortal_report_game(
            _report_from_wall(wall),
            "https://mjai.ekyu.moe/report/example.json",
            "game_0001",
            "2026-07-31T00:00:00Z",
        )
        return game

    def test_reconstructs_known_positions_and_all_historical_snapshots(self):
        source_wall = build_wall(random.Random(321))
        game = self._build_game(source_wall)
        result = reconstruct_imported_walls(
            game,
            24680,
            generated_at="2026-07-31T00:00:01Z",
        )

        self.assertEqual(result, {"seed": 24680, "roundCount": 1})
        self.assertFalse(game["metadata"]["readOnly"])
        self.assertNotIn("readOnlyReason", game["metadata"])
        self.assertEqual(game["metadata"]["wallReconstruction"]["seed"], 24680)

        snapshots = [node["snapshot"] for node in game["nodes"].values()]
        reconstructed_walls = [snapshot["fullWall"] for snapshot in snapshots]
        self.assertTrue(all(len(wall) == 136 for wall in reconstructed_walls))
        self.assertTrue(all(wall == reconstructed_walls[0] for wall in reconstructed_walls))
        wall = reconstructed_walls[0]
        self.assertEqual(Counter(wall), Counter(source_wall))
        self.assertEqual(list(wall[:52]), source_wall[:52])
        self.assertEqual(wall[52], source_wall[52])
        self.assertEqual(wall[RINSHAN_DRAW_POSITIONS[0]], source_wall[RINSHAN_DRAW_POSITIONS[0]])
        self.assertEqual(wall[DORA_POSITIONS[0]], source_wall[DORA_POSITIONS[0]])
        self.assertEqual(wall[DORA_POSITIONS[1]], source_wall[DORA_POSITIONS[1]])

        tsumo_nodes = [node for node in game["nodes"].values() if (node.get("action") or {}).get("type") == "tsumo"]
        self.assertEqual(tsumo_nodes[0]["snapshot"]["drawIndex"], 53)
        self.assertEqual(tsumo_nodes[1]["snapshot"]["drawIndex"], 53)
        self.assertEqual(tsumo_nodes[0]["snapshot"]["wallOrigin"], "reconstructed")
        self.assertEqual(len(tsumo_nodes[1]["snapshot"]["rinshanWall"]), 3)
        self.assertEqual(len(tsumo_nodes[1]["snapshot"]["wall"]), 121)

    def test_same_seed_reconstructs_identically(self):
        source_wall = build_wall(random.Random(999))
        first = self._build_game(source_wall)
        second = copy.deepcopy(first)
        reconstruct_imported_walls(first, 13579, generated_at="a")
        reconstruct_imported_walls(second, 13579, generated_at="b")

        first_wall = first["nodes"][first["rootNodeId"]]["snapshot"]["fullWall"]
        second_wall = second["nodes"][second["rootNodeId"]]["snapshot"]["fullWall"]
        self.assertEqual(first_wall, second_wall)


if __name__ == "__main__":
    unittest.main()
