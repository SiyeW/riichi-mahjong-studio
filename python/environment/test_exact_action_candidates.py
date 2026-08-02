import unittest
from unittest.mock import patch

import service
from service_helpers import build_comparison_result


class ExactActionCandidatesTest(unittest.TestCase):
    def test_chi_enumerates_red_and_normal_five_consumption(self):
        snapshot = {
            "hands": [
                ["5p", "5pr", "6p"],
                [],
                [],
                [],
            ],
        }

        actions = service._build_local_chi_actions(  # pylint: disable=protected-access
            snapshot,
            0,
            "4p",
        )

        self.assertEqual(
            {tuple(action["consumed"]) for action in actions},
            {("5p", "6p"), ("5pr", "6p")},
        )
        self.assertEqual(len({action["id"] for action in actions}), 2)

    def test_pon_combinations_preserve_red_and_normal_variants(self):
        combinations = service._unique_consumed_combinations(  # pylint: disable=protected-access
            ["5p", "5p", "5pr"],
            2,
        )

        self.assertEqual(
            {tuple(consumed) for consumed in combinations},
            {("5p", "5p"), ("5p", "5pr")},
        )

    def test_equal_tedashi_score_is_not_a_threshold_mistake(self):
        analysis = {
            "discardEntries": [
                {
                    "candidateId": "dahai:1m:tsumo",
                    "pai": "1m",
                    "tsumogiri": True,
                    "value": 1.25,
                    "probability": 0.42,
                    "bar": 0.42,
                    "isBest": True,
                },
                {
                    "candidateId": "dahai:1m",
                    "pai": "1m",
                    "value": 1.25,
                    "probability": 0.42,
                    "bar": 0.42,
                    "isBest": False,
                },
            ],
        }

        comparison = build_comparison_result(analysis, "1m", 0, False)

        self.assertFalse(comparison["isBest"])
        self.assertEqual(comparison["valueGap"], 0.0)
        with patch.object(
            service,
            "get_training_config",
            return_value={"mode": "threshold_review", "mistakeThreshold": 1.0},
        ):
            self.assertFalse(service.should_trigger_review(comparison))


if __name__ == "__main__":
    unittest.main()
