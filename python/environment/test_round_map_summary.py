from __future__ import annotations

import copy
import unittest

import service


class RoundMapSummaryTests(unittest.TestCase):
    def test_round_summary_includes_main_branch_settlement(self):
        game = service.create_empty_game(123456)
        node_id = game["currentNodeId"]
        snapshot = copy.deepcopy(game["nodes"][node_id]["snapshot"])
        snapshot["phase"] = "round_result"
        snapshot["scores"] = [33000, 23000, 22000, 22000]
        snapshot["matchState"]["scores"] = snapshot["scores"][:]
        snapshot["lastAction"] = {
            "type": "round_result",
            "result": {
                "eventType": "hora",
                "eventData": {
                    "actor": 0,
                    "target": 1,
                    "deltas": [8000, -8000, 0, 0],
                },
            },
        }
        game["nodes"][node_id]["snapshot"] = snapshot
        previous_seat = service.STATE.get("controlledSeat")
        service.STATE["controlledSeat"] = 0
        try:
            tree = service.build_tree_view(game, node_id)
        finally:
            service.STATE["controlledSeat"] = previous_seat

        self.assertEqual(len(tree["rounds"]), 1)
        result = tree["rounds"][0]["resultInfo"]
        self.assertEqual(result["title"], "自家 荣和 下家")
        self.assertEqual(result["scores"], [33000, 23000, 22000, 22000])
        self.assertEqual(result["deltas"], [8000, -8000, 0, 0])
        self.assertEqual(tree["rounds"][0]["tailScores"], [33000, 23000, 22000, 22000])
        self.assertEqual(tree["rounds"][0]["tailPhase"], "round_result")

    def test_round_summary_uses_match_end_as_the_final_result(self):
        game = service.create_empty_game(654321)
        round_root_id = game["currentNodeId"]
        final_scores = [41000, 26000, 19000, 14000]
        result_snapshot = copy.deepcopy(game["nodes"][round_root_id]["snapshot"])
        result_snapshot["phase"] = "round_result"
        result_snapshot["lastAction"] = {
            "type": "round_result",
            "result": {
                "eventType": "hora",
                "eventData": {
                    "actor": 0,
                    "target": 0,
                    "deltas": [16000, -6000, -5000, -5000],
                },
                "scores": final_scores,
            },
        }
        result_id = service.create_node(
            game,
            round_root_id,
            {"type": "round_result", "source": "system"},
            result_snapshot,
        )
        game["nodes"][round_root_id]["mainChildId"] = result_id

        end_snapshot = copy.deepcopy(result_snapshot)
        end_snapshot["phase"] = "match_end"
        end_snapshot["lastAction"] = {
            "type": "match_result",
            "result": {
                "scores": final_scores,
                "bakaze": "S",
                "kyoku": 4,
            },
        }
        end_id = service.create_node(
            game,
            result_id,
            {"type": "match_end", "source": "system"},
            end_snapshot,
        )
        game["nodes"][result_id]["mainChildId"] = end_id

        tree = service.build_tree_view(game, end_id)

        round_summary = tree["rounds"][0]
        self.assertEqual(round_summary["resultInfo"]["eventType"], "round_result")
        self.assertEqual(round_summary["resultInfo"]["deltas"], [16000, -6000, -5000, -5000])
        self.assertEqual(round_summary["matchEndInfo"]["title"], "终局")
        self.assertEqual(round_summary["matchEndInfo"]["scores"], final_scores)
        self.assertEqual(tree["rounds"][0]["tailPhase"], "match_end")

    def test_round_summary_reads_legacy_imported_match_end_scores(self):
        game = service.create_empty_game(654322)
        round_root_id = game["currentNodeId"]
        final_scores = [39000, 28000, 18000, 15000]
        result_snapshot = copy.deepcopy(game["nodes"][round_root_id]["snapshot"])
        result_snapshot["phase"] = "round_result"
        result_snapshot["lastAction"] = {
            "type": "round_result",
            "result": {"scores": final_scores},
        }
        result_snapshot["actionHistory"].append(copy.deepcopy(result_snapshot["lastAction"]))
        result_id = service.create_node(
            game,
            round_root_id,
            {"type": "round_result", "source": "mortal-report"},
            result_snapshot,
        )
        game["nodes"][round_root_id]["mainChildId"] = result_id

        end_snapshot = copy.deepcopy(result_snapshot)
        end_snapshot["phase"] = "match_end"
        end_snapshot["lastAction"] = {"type": "match_end", "source": "mortal-report"}
        end_id = service.create_node(
            game,
            result_id,
            {"type": "match_end", "source": "mortal-report"},
            end_snapshot,
        )
        game["nodes"][result_id]["mainChildId"] = end_id

        tree = service.build_tree_view(game, end_id)

        self.assertEqual(tree["rounds"][0]["resultInfo"]["title"], "结算")
        self.assertEqual(tree["rounds"][0]["matchEndInfo"]["title"], "终局")
        self.assertEqual(tree["rounds"][0]["matchEndInfo"]["scores"], final_scores)

    def test_ongoing_main_round_keeps_next_round_as_a_side_branch(self):
        game = service.create_empty_game(777777)
        round_root_id = game["currentNodeId"]
        round_root = game["nodes"][round_root_id]

        main_snapshot = copy.deepcopy(round_root["snapshot"])
        main_snapshot["phase"] = "discard"
        main_snapshot["scores"] = [24000, 25000, 25000, 25000]
        main_snapshot["matchState"]["scores"] = main_snapshot["scores"][:]
        main_id = service.create_node(
            game,
            round_root_id,
            {"type": "dahai", "actor": 0, "pai": "1m", "source": "test"},
            main_snapshot,
        )
        round_root["mainChildId"] = main_id

        side_snapshot = copy.deepcopy(round_root["snapshot"])
        side_snapshot["roundIndex"] = 1
        side_snapshot["kyoku"] = 2
        side_snapshot["matchState"]["roundIndex"] = 1
        side_snapshot["matchState"]["kyoku"] = 2
        side_id = service.create_node(
            game,
            round_root_id,
            {"type": "start_kyoku", "source": "test"},
            side_snapshot,
        )

        tree = service.build_tree_view(game, main_id)
        rounds = {round_info["id"]: round_info for round_info in tree["rounds"]}
        main_round = rounds[round_root_id]

        self.assertIsNone(main_round["mainNextRoundId"])
        self.assertEqual(main_round["childRoundIds"], [side_id])
        self.assertIsNone(main_round["resultInfo"])
        self.assertEqual(main_round["tailScores"], [24000, 25000, 25000, 25000])
        self.assertEqual(main_round["tailPhase"], "discard")


if __name__ == "__main__":
    unittest.main()
