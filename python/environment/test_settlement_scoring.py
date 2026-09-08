import unittest

import settlement

from mahjong.constants import EAST, SOUTH
from mahjong.hand_calculating.hand_config import HandConfig
from mahjong.hand_calculating.scores import ScoresCalculator


class SettlementScoringRulesTests(unittest.TestCase):
    def score(self, *, is_tsumo: bool, is_dealer: bool, han: int = 4, fu: int = 30):
        config = HandConfig(
            is_tsumo=is_tsumo,
            player_wind=EAST if is_dealer else SOUTH,
            options=settlement.build_network_scoring_rules(),
        )
        return ScoresCalculator.calculate_scores(han=han, fu=fu, config=config)

    def test_four_han_thirty_fu_is_not_kiriage_mangan(self):
        non_dealer_ron = self.score(is_tsumo=False, is_dealer=False)
        non_dealer_tsumo = self.score(is_tsumo=True, is_dealer=False)
        dealer_ron = self.score(is_tsumo=False, is_dealer=True)
        dealer_tsumo = self.score(is_tsumo=True, is_dealer=True)

        self.assertEqual(non_dealer_ron["main"], 7700)
        self.assertEqual(non_dealer_tsumo["main"], 3900)
        self.assertEqual(non_dealer_tsumo["additional"], 2000)
        self.assertEqual(non_dealer_tsumo["total"], 7900)
        self.assertEqual(dealer_ron["main"], 11600)
        self.assertEqual(dealer_tsumo["main"], 3900)
        self.assertEqual(dealer_tsumo["total"], 11700)
        self.assertEqual(non_dealer_ron["yaku_level"], "")

    def test_three_han_sixty_fu_is_not_kiriage_mangan(self):
        ron = self.score(is_tsumo=False, is_dealer=False, han=3, fu=60)
        tsumo = self.score(is_tsumo=True, is_dealer=False, han=3, fu=60)

        self.assertEqual(ron["main"], 7700)
        self.assertEqual(tsumo["main"], 3900)
        self.assertEqual(tsumo["additional"], 2000)
        self.assertEqual(tsumo["total"], 7900)
        self.assertEqual(ron["yaku_level"], "")


if __name__ == "__main__":
    unittest.main()
