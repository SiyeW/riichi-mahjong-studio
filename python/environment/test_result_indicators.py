from __future__ import annotations

import copy
import unittest

import service


class ResultIndicatorTests(unittest.TestCase):
    def setUp(self):
        service.STATE["controlledSeat"] = 0

    @staticmethod
    def _snapshot():
        game = service.create_empty_game(123456)
        return copy.deepcopy(game["nodes"][game["currentNodeId"]]["snapshot"])

    def test_terminal_result_preserves_ura_markers(self):
        snapshot = self._snapshot()
        snapshot["lastAction"] = {
            "type": "hora",
            "actor": 0,
            "target": 1,
            "deltas": [8000, -8000, 0, 0],
            "uraMarkers": ["2p", "7s"],
        }

        result = service.build_terminal_round_result(snapshot)

        self.assertEqual(result["eventData"]["uraMarkers"], ["2p", "7s"])

    def test_result_info_exposes_ura_markers(self):
        snapshot = self._snapshot()
        snapshot["lastAction"] = {
            "type": "round_result",
            "result": {
                "eventType": "hora",
                "eventData": {
                    "actor": 2,
                    "target": 2,
                    "deltas": [0, 0, 6000, 0],
                    "uraMarkers": ["C"],
                },
            },
        }

        result_info = service.build_result_info(snapshot)

        self.assertEqual(result_info["uraMarkers"], ["C"])

    def test_round_result_keeps_table_scores_until_next_round(self):
        snapshot = self._snapshot()
        snapshot["scores"] = [25000, 25000, 25000, 25000]
        round_result = {
            "canRenchan": False,
            "hasHora": True,
            "hasAbortiveRyukyoku": False,
            "kyotakuLeft": 0,
            "scores": [33000, 17000, 25000, 25000],
            "eventType": "hora",
            "eventData": {
                "actor": 0,
                "target": 1,
                "deltas": [8000, -8000, 0, 0],
            },
        }
        next_match_state = copy.deepcopy(snapshot["matchState"])
        next_match_state["scores"] = round_result["scores"][:]

        result_snapshot = service.create_round_result_snapshot(snapshot, round_result, next_match_state)
        result_info = service.build_result_info(result_snapshot)

        self.assertEqual(result_snapshot["scores"], [25000, 25000, 25000, 25000])
        self.assertEqual(result_info["scores"], [33000, 17000, 25000, 25000])
        next_snapshot = service.create_next_kyoku_snapshot(result_snapshot, next_match_state)
        self.assertEqual(next_snapshot["scores"], [33000, 17000, 25000, 25000])

    def test_ryukyoku_result_uses_direct_normalized_title(self):
        expected_titles = {
            "exhaustive_draw": "荒牌流局",
            "kyuushu_kyuuhai": "九种九牌",
            "suufon_renda": "四风连打",
            "suukantsu": "四杠散了",
        }
        for reason, expected in expected_titles.items():
            with self.subTest(reason=reason):
                snapshot = self._snapshot()
                snapshot["lastAction"] = {
                    "type": "round_result",
                    "result": {
                        "eventType": "ryukyoku",
                        "scores": [25000] * 4,
                        "eventData": {
                            "reason": reason,
                            "reasonLabel": "流局",
                            "deltas": [0] * 4,
                        },
                    },
                }

                self.assertEqual(service.build_result_info(snapshot)["title"], expected)


if __name__ == "__main__":
    unittest.main()
