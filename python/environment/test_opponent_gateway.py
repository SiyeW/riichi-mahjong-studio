import unittest

from opponent_gateway import OpponentAnalysisGateway
from shanten_gateway import ShantenPredictorGateway, TILE34_NAMES


class OpponentOutputCompositionTest(unittest.TestCase):
    def test_shanten_contract_can_be_consumed_without_deal_in_output(self):
        gateway = ShantenPredictorGateway(enabled_outputs=["opponent-shanten"])
        try:
            players = gateway._validate_protocol_prediction(
                {
                    "outputs": [{
                        "id": "opponent-shanten",
                        "version": 1,
                        "data": {
                            "players": [
                                {
                                    "seat": seat,
                                    "shanten": [
                                        {"value": value, "probability": 1.0 if value == 1 else 0.0}
                                        for value in range(7)
                                    ],
                                    "furitenOrNoYaku": 0.25,
                                }
                                for seat in (1, 2, 3)
                            ],
                        },
                    }],
                },
                controlled_seat=0,
            )
            self.assertEqual(len(players), 3)
            self.assertTrue(all("shanten" in player for player in players))
            self.assertTrue(all("ronWaits" not in player for player in players))
        finally:
            gateway.shutdown()

    def test_deal_in_contract_can_be_consumed_without_shanten_output(self):
        gateway = ShantenPredictorGateway(
            enabled_outputs=["opponent-deal-in-probability"],
        )
        try:
            players = gateway._validate_protocol_prediction(
                {
                    "outputs": [{
                        "id": "opponent-deal-in-probability",
                        "version": 1,
                        "data": {
                            "players": [
                                {
                                    "seat": seat,
                                    "tiles": {tile: 0.01 for tile in TILE34_NAMES},
                                }
                                for seat in (1, 2, 3)
                            ],
                        },
                    }],
                },
                controlled_seat=0,
            )
            self.assertEqual(len(players), 3)
            self.assertTrue(all("ronWaits" in player for player in players))
            self.assertTrue(all("shanten" not in player for player in players))
        finally:
            gateway.shutdown()

    def test_partial_host_results_merge_without_overwriting_each_other(self):
        combined = OpponentAnalysisGateway._merge_results([
            {
                "predictions": {"opponents": {"shimocha": [1.0]}, "ron_wait": {}},
                "ground_truth": {"opponents": {}, "ron_wait": {}},
                "raw": {"shimocha": {"seat": 1, "shanten_probs": [1.0]}},
                "context": {"nodeId": "n_1"},
                "status": "ready",
            },
            {
                "predictions": {"opponents": {}, "ron_wait": {"shimocha": [0.1]}},
                "ground_truth": {"opponents": {}, "ron_wait": {}},
                "raw": {"shimocha": {"seat": 1, "ron_wait": [0.1]}},
                "context": {"nodeId": "n_1"},
                "status": "ready",
            },
        ])
        self.assertEqual(combined["predictions"]["opponents"]["shimocha"], [1.0])
        self.assertEqual(combined["predictions"]["ron_wait"]["shimocha"], [0.1])
        self.assertIn("shanten_probs", combined["raw"]["shimocha"])
        self.assertIn("ron_wait", combined["raw"]["shimocha"])


if __name__ == "__main__":
    unittest.main()
