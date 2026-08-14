import copy
import unittest
from unittest import mock

import service


class TreeDeletionTest(unittest.TestCase):
    def setUp(self):
        service.STATE["game"] = None
        service.STATE["gameLoaded"] = False
        service.STATE["mode"] = "research"
        service.STATE["nextGameId"] = 1

    @staticmethod
    def _append_node(game, parent_id, node_id, *, round_index=0):
        parent = game["nodes"][parent_id]
        snapshot = copy.deepcopy(parent["snapshot"])
        snapshot["roundIndex"] = round_index
        snapshot["matchState"]["roundIndex"] = round_index
        game["nodes"][node_id] = {
            "id": node_id,
            "type": "action",
            "parentId": parent_id,
            "children": [],
            "mainChildId": None,
            "action": {"type": "dahai", "actor": 0, "pai": "1m"},
            "actor": 0,
            "snapshot": snapshot,
            "analysisCache": {},
            "depth": int(parent["depth"]) + 1,
        }
        parent["children"].append(node_id)
        return node_id

    def test_deleting_current_node_removes_descendants_across_rounds(self):
        game = service.create_empty_game(111111)
        parent_id = game["currentNodeId"]
        target_id = self._append_node(game, parent_id, "target")
        next_round_id = self._append_node(game, target_id, "next_round", round_index=1)
        final_id = self._append_node(game, next_round_id, "final", round_index=1)
        sibling_id = self._append_node(game, parent_id, "sibling")
        game["nodes"][parent_id]["mainChildId"] = target_id
        game["nodes"][target_id]["mainChildId"] = next_round_id
        game["nodes"][next_round_id]["mainChildId"] = final_id
        game["mainLeafNodeId"] = final_id
        game["currentNodeId"] = target_id
        service.STATE["game"] = game
        service.STATE["gameLoaded"] = True

        with (
            mock.patch.object(service, "cancel_auto_analysis"),
            mock.patch.object(service, "purge_bg_analysis_tasks"),
            mock.patch.object(service, "purge_stale_mjai_stream_cache"),
            mock.patch.object(service, "request_current_opponent_analysis"),
        ):
            deleted_count = service.delete_node(target_id)

        self.assertEqual(deleted_count, 3)
        self.assertNotIn(target_id, game["nodes"])
        self.assertNotIn(next_round_id, game["nodes"])
        self.assertNotIn(final_id, game["nodes"])
        self.assertIn(sibling_id, game["nodes"])
        self.assertEqual(game["currentNodeId"], parent_id)
        self.assertEqual(game["nodes"][parent_id]["children"], [sibling_id])
        self.assertEqual(game["nodes"][parent_id]["mainChildId"], sibling_id)
        self.assertEqual(game["mainLeafNodeId"], sibling_id)

    def test_deleting_side_branch_keeps_existing_main_branch(self):
        game = service.create_empty_game(222222)
        parent_id = game["currentNodeId"]
        main_id = self._append_node(game, parent_id, "main")
        side_id = self._append_node(game, parent_id, "side")
        game["nodes"][parent_id]["mainChildId"] = main_id
        game["mainLeafNodeId"] = main_id
        game["currentNodeId"] = side_id
        service.STATE["game"] = game
        service.STATE["gameLoaded"] = True

        with (
            mock.patch.object(service, "cancel_auto_analysis"),
            mock.patch.object(service, "purge_bg_analysis_tasks"),
            mock.patch.object(service, "purge_stale_mjai_stream_cache"),
            mock.patch.object(service, "request_current_opponent_analysis"),
        ):
            service.delete_node(side_id)

        self.assertEqual(game["nodes"][parent_id]["children"], [main_id])
        self.assertEqual(game["nodes"][parent_id]["mainChildId"], main_id)
        self.assertEqual(game["mainLeafNodeId"], main_id)

    def test_root_node_cannot_be_deleted(self):
        game = service.create_empty_game(333333)
        game["currentNodeId"] = game["rootNodeId"]
        service.STATE["game"] = game
        service.STATE["gameLoaded"] = True

        with self.assertRaisesRegex(ValueError, "root node"):
            service.delete_node(game["rootNodeId"])


if __name__ == "__main__":
    unittest.main()
