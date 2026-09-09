import unittest
from unittest import mock

from rms_backend.round_wall_replacement import (
    RoundWallReplacement,
    RoundWallReplacementDependencies,
)


class RoundWallReplacementTest(unittest.TestCase):
    def test_replaces_the_round_subtree_and_retires_derived_state(self):
        game = {
            "gameId": "game_0001",
            "matchId": "match_0001",
            "currentNodeId": "child",
            "rootNodeId": "root",
            "mainLeafNodeId": "child",
            "nextNodeIndex": 3,
            "treeRevision": 1,
            "nodes": {
                "root": {
                    "id": "root",
                    "type": "root",
                    "parentId": None,
                    "children": ["child"],
                    "mainChildId": "child",
                    "action": None,
                    "snapshot": {"matchState": {"roundIndex": 0}},
                    "depth": 0,
                },
                "child": {
                    "id": "child",
                    "parentId": "root",
                    "children": [],
                    "snapshot": {},
                },
            },
        }
        ensure_loaded = mock.Mock()
        purge_decision = mock.Mock()
        invalidate_timeline = mock.Mock()
        promote_mainline = mock.Mock()
        purge_mjai = mock.Mock()
        replacement = RoundWallReplacement(
            {"game": game},
            RoundWallReplacementDependencies(
                ensure_game_loaded=ensure_loaded,
                validate_full_wall=lambda wall: list(wall),
                create_initial_snapshot=lambda match_state, _wall: {
                    "matchState": dict(match_state),
                },
                resolve_round_root=lambda _game, _node_id: "root",
                collect_subtree_ids=lambda _game, _root_id: ["root", "child"],
                purge_decision_analysis=purge_decision,
                invalidate_analysis_timeline=invalidate_timeline,
                promote_mainline=promote_mainline,
                purge_mjai_cache=purge_mjai,
            ),
        )

        node_id = replacement.replace(["1m"])

        self.assertEqual(node_id, "n_3")
        self.assertEqual(set(game["nodes"]), {"n_3"})
        self.assertEqual(game["rootNodeId"], "n_3")
        self.assertEqual(game["currentNodeId"], "n_3")
        self.assertEqual(game["nodes"]["n_3"]["snapshot"]["wallOrigin"], "imported")
        self.assertEqual(game["matchState"]["matchId"], "match_0001")
        self.assertEqual(game["treeRevision"], 2)
        ensure_loaded.assert_called_once_with()
        purge_decision.assert_called_once_with("game_0001", ["root", "child"])
        invalidate_timeline.assert_called_once_with()
        promote_mainline.assert_called_once_with(game, "n_3")
        purge_mjai.assert_called_once_with("game_0001")


if __name__ == "__main__":
    unittest.main()
