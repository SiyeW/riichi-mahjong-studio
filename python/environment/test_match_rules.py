import unittest
from unittest import mock

import match_progression
import service
import settlement


class MatchEndRuleTests(unittest.TestCase):
    @staticmethod
    def _round_result(scores, *, abortive=False):
        return {
            "scores": scores,
            "kyotakuLeft": 0,
            "canRenchan": False,
            "hasHora": not abortive,
            "hasAbortiveRyukyoku": abortive,
        }

    def test_negative_score_ends_match_before_all_last(self):
        match_state = service.create_match_state(123456)

        result = match_progression.apply_round_result_to_match_state(
            match_state,
            self._round_result([-100, 30100, 35000, 35000]),
        )

        self.assertTrue(result["ended"])
        self.assertEqual(result["roundIndex"], 0)

    def test_zero_score_does_not_end_match_before_all_last(self):
        match_state = service.create_match_state(123456)

        result = match_progression.apply_round_result_to_match_state(
            match_state,
            self._round_result([0, 30000, 35000, 35000]),
        )

        self.assertFalse(result["ended"])
        self.assertEqual(result["roundIndex"], 1)

    def test_negative_score_also_ends_after_abortive_draw(self):
        match_state = service.create_match_state(123456)

        result = match_progression.apply_round_result_to_match_state(
            match_state,
            self._round_result([-100, 30100, 35000, 35000], abortive=True),
        )

        self.assertTrue(result["ended"])
        self.assertEqual(result["roundIndex"], 0)

    def test_match_end_node_is_created_with_the_settlement_node(self):
        previous_game = service.STATE.get("game")
        previous_loaded = service.STATE.get("gameLoaded")
        game = service.create_empty_game(123456)
        snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
        snapshot["phase"] = "game_end"
        snapshot["scores"] = [-100, 30100, 35000, 35000]
        snapshot["matchState"]["scores"] = snapshot["scores"][:]
        game["matchState"]["scores"] = snapshot["scores"][:]
        service.STATE["game"] = game
        service.STATE["gameLoaded"] = True

        try:
            service.advance_terminal_round(game)

            round_node = game["nodes"][game["currentNodeId"]]
            self.assertEqual(round_node["snapshot"]["phase"], "round_result")
            self.assertEqual(len(round_node["children"]), 1)
            end_node_id = round_node["children"][0]
            end_node = game["nodes"][end_node_id]
            self.assertEqual(end_node["action"]["type"], "match_end")
            self.assertEqual(end_node["snapshot"]["phase"], "match_end")
            self.assertEqual(game["mainLeafNodeId"], end_node_id)

            node_count = len(game["nodes"])
            service.advance_game_flow(game)
            self.assertEqual(game["currentNodeId"], end_node_id)
            self.assertEqual(len(game["nodes"]), node_count)
            self.assertEqual(
                service.build_result_info(end_node["snapshot"])["title"],
                "终局",
            )
        finally:
            service.STATE["game"] = previous_game
            service.STATE["gameLoaded"] = previous_loaded


class RiichiPointRuleTests(unittest.TestCase):
    @staticmethod
    def _riichi_snapshot(score):
        initial_hand = [
            "1m", "2m", "3m", "4m", "5m", "6m", "7m",
            "8m", "9m", "1p", "1p", "2p", "2p",
        ]
        draw = {"type": "tsumo", "actor": 0, "pai": "3p"}
        return {
            "initialHands": [initial_hand, ["1s"] * 13, ["2s"] * 13, ["3s"] * 13],
            "bakaze": "E",
            "kyoku": 1,
            "honba": 0,
            "kyotaku": 0,
            "startKyotaku": 0,
            "dealer": 0,
            "scores": [score, 25000, 25000, 25000],
            "startScores": [score, 25000, 25000, 25000],
            "doraIndicators": ["9s"],
            "actionHistory": [draw],
            "lastAction": draw,
            "phase": "discard",
            "currentActor": 0,
            "wall": ["1s"] * 122,
            "drawIndex": 53,
            "rivers": [[], [], [], []],
            "melds": [[], [], [], []],
            "riichiAccepted": [False, False, False, False],
        }

    def test_riichi_requires_at_least_1000_points(self):
        self.assertFalse(
            settlement.can_declare_riichi(self._riichi_snapshot(999), 0)
        )
        self.assertTrue(
            settlement.can_declare_riichi(self._riichi_snapshot(1000), 0)
        )

    def test_riichi_accepts_shared_immutable_wall_storage(self):
        snapshot = self._riichi_snapshot(25000)
        snapshot["wall"] = tuple(snapshot["wall"])

        self.assertTrue(settlement.can_declare_riichi(snapshot, 0))
        self.assertTrue(
            any(
                action.get("type") == "reach"
                for action in service.build_legal_actions(snapshot, controlled_seat=0)
            )
        )

    def test_ai_illegal_riichi_response_falls_back_to_discard(self):
        game = service.create_empty_game(123456)
        snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
        snapshot["currentActor"] = 1
        snapshot["hands"][1] = ["1m"]

        with (
            mock.patch.object(service, "actor_just_drew", return_value=True),
            mock.patch.object(
                service,
                "choose_ai_action_for_current_node",
                return_value={"type": "reach", "actor": 1},
            ),
            mock.patch.object(
                service,
                "can_declare_riichi",
                return_value=False,
            ) as can_declare_riichi,
        ):
            action = service.choose_ai_discard(snapshot, 1)

        self.assertEqual(action["type"], "dahai")
        can_declare_riichi.assert_called_once_with(snapshot, 1)


if __name__ == "__main__":
    unittest.main()
