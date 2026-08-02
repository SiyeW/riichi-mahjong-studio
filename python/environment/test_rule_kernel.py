import unittest

import rule_kernel


def make_snapshot(initial_hand, actions, **overrides):
    snapshot = {
        "initialHands": [
            list(initial_hand),
            ["1s"] * 13,
            ["2s"] * 13,
            ["3s"] * 13,
        ],
        "bakaze": "E",
        "kyoku": 1,
        "honba": 0,
        "kyotaku": 0,
        "startKyotaku": 0,
        "dealer": 0,
        "scores": [25000] * 4,
        "startScores": [25000] * 4,
        "doraIndicators": ["9s"],
        "actionHistory": list(actions),
        "lastAction": actions[-1] if actions else {},
        "phase": "discard",
        "currentActor": 0,
        "wall": ["1s"] * 122,
        "drawIndex": 53,
        "rivers": [[], [], [], []],
        "melds": [[], [], [], []],
        "riichiAccepted": [False] * 4,
    }
    snapshot.update(overrides)
    return snapshot


class RuleKernelTests(unittest.TestCase):
    def test_tsumo_frame_reports_shanten_and_riichi_discards(self):
        hand = [
            "1m", "2m", "3m", "4m", "5m", "6m", "7m",
            "8m", "9m", "1p", "1p", "2p", "2p",
        ]
        snapshot = make_snapshot(hand, [{"type": "tsumo", "actor": 0, "pai": "3p"}])
        state = rule_kernel.build_player_state(snapshot, 0)

        self.assertEqual(rule_kernel.compute_shanten(snapshot, 0, state=state), 0)
        self.assertEqual(
            rule_kernel.get_valid_riichi_discards(snapshot, 0, state=state),
            ["1p", "2p", "3p"],
        )
        self.assertTrue(rule_kernel.can_declare_riichi(snapshot, 0, state=state))
        self.assertFalse(rule_kernel.can_declare_ron(snapshot, 0, state=state))

    def test_shared_immutable_wall_preserves_remaining_tiles(self):
        hand = [
            "1m", "2m", "3m", "4m", "5m", "6m", "7m",
            "8m", "9m", "1p", "1p", "2p", "2p",
        ]
        snapshot = make_snapshot(hand, [{"type": "tsumo", "actor": 0, "pai": "3p"}])
        snapshot["wall"] = tuple(snapshot["wall"])

        state = rule_kernel.build_player_state(snapshot, 0)

        self.assertEqual(state.game.wall_remaining, 69)
        self.assertTrue(rule_kernel.can_declare_riichi(snapshot, 0, state=state))

    def test_complete_closed_hand_can_tsumo(self):
        hand = [
            "2m", "3m", "4m", "7m", "8m", "9m", "1p",
            "2p", "3p", "4p", "5p", "6p", "6p",
        ]
        snapshot = make_snapshot(hand, [{"type": "tsumo", "actor": 0, "pai": "6p"}])

        self.assertTrue(rule_kernel.can_declare_tsumo(snapshot, 0))

    def test_ron_and_discard_furiten(self):
        waiting_hand = [
            "1m", "2m", "3m", "4m", "5m", "6m", "7m",
            "8m", "9m", "1p", "2p", "3p", "1s",
        ]
        opponent_discard = [
            {"type": "tsumo", "actor": 3, "pai": "?"},
            {"type": "dahai", "actor": 3, "pai": "1s", "tsumogiri": False},
        ]
        snapshot = make_snapshot(
            waiting_hand,
            opponent_discard,
            phase="reaction_window",
            currentActor=3,
            reactionWindow={"discard": {"actor": 3, "pai": "1s"}},
            rivers=[[], [], [], ["1s"]],
            drawIndex=54,
        )
        self.assertTrue(rule_kernel.can_declare_ron(snapshot, 0))

        furiten_initial = waiting_hand.copy()
        furiten_initial[11] = "1s"
        history = [
            {"type": "tsumo", "actor": 0, "pai": "3p"},
            {"type": "dahai", "actor": 0, "pai": "1s", "tsumogiri": False},
            {"type": "tsumo", "actor": 3, "pai": "?"},
            {"type": "dahai", "actor": 3, "pai": "1s", "tsumogiri": False},
        ]
        furiten = make_snapshot(
            furiten_initial,
            history,
            phase="reaction_window",
            currentActor=3,
            reactionWindow={"discard": {"actor": 3, "pai": "1s"}},
            rivers=[["1s"], [], [], ["1s"]],
            drawIndex=55,
        )
        self.assertFalse(rule_kernel.can_declare_ron(furiten, 0))

    def test_passing_ron_causes_same_cycle_furiten(self):
        hand = [
            "1m", "2m", "3m", "4m", "5m", "6m", "7p",
            "8p", "9p", "3s", "4s", "5p", "5p",
        ]
        first_discard = [
            {"type": "tsumo", "actor": 3, "pai": "?"},
            {"type": "dahai", "actor": 3, "pai": "2s", "tsumogiri": False},
        ]
        first = make_snapshot(
            hand,
            first_discard,
            phase="reaction_window",
            currentActor=3,
            reactionWindow={"discard": {"actor": 3, "pai": "2s"}},
            drawIndex=54,
        )
        self.assertTrue(rule_kernel.can_declare_ron(first, 0))

        passed = make_snapshot(
            hand,
            first_discard + [
                {
                    "type": "pon",
                    "actor": 1,
                    "target": 3,
                    "pai": "2s",
                    "consumed": ["2s", "2s"],
                },
                {"type": "dahai", "actor": 1, "pai": "5s", "tsumogiri": False},
            ],
            phase="reaction_window",
            currentActor=1,
            reactionWindow={"discard": {"actor": 1, "pai": "5s"}},
            drawIndex=54,
        )
        self.assertFalse(rule_kernel.can_declare_ron(passed, 0))

    def test_chankan_supplies_yaku_for_an_open_hand(self):
        hand = [
            "4p", "5p", "6p", "7s", "8s", "9s", "3m",
            "4m", "5p", "5p", "1m", "2m", "E",
        ]
        prefix = [
            {"type": "dahai", "actor": 3, "pai": "3m", "tsumogiri": False},
            {
                "type": "chi",
                "actor": 0,
                "target": 3,
                "pai": "3m",
                "consumed": ["1m", "2m"],
            },
            {"type": "dahai", "actor": 0, "pai": "E", "tsumogiri": False},
        ]
        melds = [[{
            "type": "chi",
            "actor": 0,
            "target": 3,
            "pai": "3m",
            "consumed": ["1m", "2m"],
        }], [], [], []]
        regular = make_snapshot(
            hand,
            prefix + [{"type": "dahai", "actor": 3, "pai": "2m", "tsumogiri": False}],
            phase="reaction_window",
            currentActor=3,
            reactionWindow={"discard": {"actor": 3, "pai": "2m"}},
            melds=melds,
        )
        regular["wall"] = tuple(regular["wall"])
        self.assertFalse(rule_kernel.can_declare_ron(regular, 0))

        kakan = {
            "type": "kakan",
            "actor": 3,
            "pai": "2m",
            "consumed": ["2m", "2m", "2m"],
        }
        chankan = make_snapshot(
            hand,
            prefix + [kakan],
            phase="kan_reaction_window",
            currentActor=3,
            pendingKan=kakan,
            kanReactionWindow={"kan": kakan},
            melds=melds,
        )
        self.assertTrue(rule_kernel.can_declare_ron(chankan, 0))

    def test_shared_immutable_wall_does_not_grant_false_haitei(self):
        hand = [
            "4p", "5p", "6p", "7s", "8s", "9s", "3m",
            "4m", "5p", "5p", "1m", "2m", "E",
        ]
        chi = {
            "type": "chi",
            "actor": 0,
            "target": 3,
            "pai": "3m",
            "consumed": ["1m", "2m"],
        }
        snapshot = make_snapshot(
            hand,
            [
                {"type": "dahai", "actor": 3, "pai": "3m", "tsumogiri": False},
                chi,
                {"type": "dahai", "actor": 0, "pai": "E", "tsumogiri": False},
                {"type": "tsumo", "actor": 0, "pai": "2m"},
            ],
            melds=[[chi], [], [], []],
        )
        snapshot["wall"] = tuple(snapshot["wall"])

        self.assertFalse(rule_kernel.can_declare_tsumo(snapshot, 0))

    def test_nine_terminals_requires_first_uninterrupted_turn(self):
        hand = [
            "1m", "9m", "1p", "9p", "1s", "9s", "E",
            "S", "W", "N", "P", "2m", "3m",
        ]
        snapshot = make_snapshot(hand, [{"type": "tsumo", "actor": 0, "pai": "F"}])
        self.assertTrue(rule_kernel.can_declare_ryukyoku(snapshot, 0))

        snapshot["rivers"][0].append("2m")
        self.assertFalse(rule_kernel.can_declare_ryukyoku(snapshot, 0))

    def test_normal_ankan_and_haitei_restriction(self):
        hand = [
            "1m", "1m", "1m", "2m", "3m", "4m", "5p",
            "6p", "7p", "2s", "3s", "4s", "E",
        ]
        snapshot = make_snapshot(hand, [{"type": "tsumo", "actor": 0, "pai": "1m"}])
        snapshot["wall"] = tuple(snapshot["wall"])
        self.assertEqual(rule_kernel.get_ankan_candidates(snapshot, 0), ["1m"])

        snapshot["drawIndex"] = len(snapshot["wall"])
        self.assertEqual(rule_kernel.get_ankan_candidates(snapshot, 0), [])

    def test_riichi_ankan_uses_tenhou_wait_rule(self):
        legal_hand = [
            "1m", "2m", "3m", "4m", "5m",
            "4s", "4s", "4s", "5s", "6s", "7s", "E", "E",
        ]
        legal = make_snapshot(
            legal_hand,
            [
                {"type": "reach", "actor": 0},
                {"type": "reach_accepted", "actor": 0},
                {"type": "tsumo", "actor": 0, "pai": "4s"},
            ],
            riichiAccepted=[True, False, False, False],
        )
        self.assertEqual(rule_kernel.get_ankan_candidates(legal, 0), ["4s"])

        illegal_hand = [
            "1m", "2m", "3m", "4m", "5m", "6m",
            "4s", "4s", "4s", "5s", "E", "E", "E",
        ]
        illegal = make_snapshot(
            illegal_hand,
            [
                {"type": "reach", "actor": 0},
                {"type": "reach_accepted", "actor": 0},
                {"type": "tsumo", "actor": 0, "pai": "4s"},
            ],
            riichiAccepted=[True, False, False, False],
        )
        self.assertEqual(rule_kernel.get_ankan_candidates(illegal, 0), [])


if __name__ == "__main__":
    unittest.main()
