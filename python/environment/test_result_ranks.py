from __future__ import annotations

import copy
import unittest

import service


class ResultRankTests(unittest.TestCase):
    def test_equal_scores_use_absolute_seat_order(self):
        self.assertEqual(
            service.rank_scores([25000, 25000, 30000, 20000]),
            [2, 3, 1, 4],
        )

    def test_result_info_includes_post_settlement_ranks(self):
        game = service.create_empty_game(123456)
        snapshot = copy.deepcopy(game["nodes"][game["currentNodeId"]]["snapshot"])
        snapshot["scores"] = [24000, 32000, 24000, 20000]
        snapshot["matchState"]["scores"] = [24000, 32000, 24000, 20000]
        snapshot["lastAction"] = {
            "type": "round_result",
            "result": {
                "eventType": "ryukyoku",
                "eventData": {
                    "reason": "exhaustive_draw",
                    "reasonLabel": "流局",
                    "deltas": [0, 0, 0, 0],
                },
            },
        }
        service.STATE["controlledSeat"] = 3

        result_info = service.build_result_info(snapshot)

        self.assertEqual(result_info["ranks"], [2, 1, 3, 4])
        self.assertEqual(result_info["title"], "荒牌流局")


if __name__ == "__main__":
    unittest.main()
