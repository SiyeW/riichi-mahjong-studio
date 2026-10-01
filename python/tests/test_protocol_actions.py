import unittest
from unittest.mock import Mock

from rms_backend import snapshot_state
from rms_backend.game_setup import create_initial_snapshot, create_match_state
from rms_backend.legal_actions import get_legal_kan_actions
from rms_backend.protocol_actions import protocol_action
from rms_backend.round_actions import RoundActions
from rms_backend.service_helpers import get_pon_tiles


class ProtocolActionTests(unittest.TestCase):
    def test_discard_preserves_physical_and_drawn_identity(self):
        for tile in ("5m", "5mr"):
            for flag in (False, True):
                choice = {"id": "opaque", "label": "Discard", "type": "dahai",
                          "actor": 0, "pai": tile}
                if flag:
                    choice["tsumogiri"] = True
                self.assertEqual(protocol_action(choice, []),
                                 {"type": "dahai", "actor": 0, "pai": tile,
                                  "tsumogiri": flag})
                self.assertNotIn("tsumogiri", choice) if not flag else None

    def test_calls_gain_target_not_ui_variant(self):
        for kind, consumed in (("chi", ["4m", "6m"]),
                               ("pon", ["5m", "5mr"]),
                               ("daiminkan", ["5m", "5m", "5mr"])):
            choice = {"type": kind, "actor": 0, "pai": "5m",
                      "consumed": consumed, "variant": kind, "id": "opaque"}
            result = protocol_action(choice, [{"type": "dahai", "actor": 3,
                                               "pai": "5m"}])
            self.assertEqual(result["target"], 3)
            self.assertEqual(result["consumed"], consumed)
            self.assertNotIn("variant", result)
            self.assertNotIn("target", choice)

    def test_win_identity_comes_from_public_event(self):
        for event in ({"type": "tsumo", "actor": 0, "pai": "5mr"},
                      {"type": "dahai", "actor": 2, "pai": "5m"},
                      {"type": "kakan", "actor": 1, "pai": "5mr"}):
            result = protocol_action({"type": "hora", "actor": 0,
                                      "variant": "tsumo" if event["type"] == "tsumo" else "hora"}, [event])
            self.assertEqual(result, {"type": "hora", "actor": 0,
                                      "target": event["actor"], "pai": event["pai"]})

    def test_kan_and_pass_variants(self):
        result = protocol_action({"type": "ankan", "actor": 0,
                                  "consumed": ["5m"] * 3 + ["5mr"],
                                  "variant": "ankan:5m"}, [])
        self.assertNotIn("variant", result)
        result = protocol_action({"type": "none", "actor": 0, "pai": "5mr",
                                  "variant": "skip_ankan"}, [])
        self.assertEqual(result, {"type": "none", "actor": 0, "pai": "5mr",
                                  "variant": "skip-ankan", "tsumogiri": True})

    def test_missing_context_is_not_guessed(self):
        with self.assertRaises(ValueError):
            protocol_action({"type": "hora", "actor": 0}, [])

    def test_context_cannot_cross_round_boundary(self):
        for boundary in ("start_kyoku", "hora", "ryukyoku", "end_kyoku", "end_game"):
            with self.subTest(boundary=boundary), self.assertRaises(ValueError):
                protocol_action({"type": "hora", "actor": 0}, [
                    {"type": "dahai", "actor": 1, "pai": "5mr"}, {"type": boundary},
                ])

    def test_invalid_required_fields_fail_before_transmission(self):
        actions = [
            {"type": "dahai", "actor": 0, "pai": "?"},
            {"type": "dahai", "actor": 0, "pai": "5m", "tsumogiri": 0},
            {"type": "ankan", "actor": 0, "consumed": ["5m"] * 3},
            {"type": "kakan", "actor": 0, "pai": "5mr", "consumed": ["?"] * 3},
            {"type": "none", "actor": 0, "variant": "skip_ankan"},
            {"type": "unknown", "actor": 0},
        ]
        for action in actions:
            with self.subTest(action=action), self.assertRaises(ValueError):
                protocol_action(action, [])

    def test_only_pass_retains_protocol_variant(self):
        for kind in ("reach", "ryukyoku"):
            self.assertEqual(protocol_action({"type": kind, "actor": 0,
                                             "variant": "internal", "riichi": True}, []),
                             {"type": kind, "actor": 0})
        self.assertEqual(protocol_action({"type": "none", "actor": 0}, []),
                         {"type": "none", "actor": 0})

    def test_added_kan_preserves_original_pon_tiles(self):
        for called, held, added in (("5mr", ["5m", "5m"], "5m"),
                                   ("5m", ["5m", "5m"], "5mr")):
            meld = {"type": "pon", "pai": called, "consumed": held}
            consumed = get_pon_tiles(meld)
            wire = protocol_action({"type": "kakan", "actor": 0, "pai": added,
                                    "consumed": consumed, "variant": "kakan:5m"}, [])
            self.assertEqual(wire, {"type": "kakan", "actor": 0, "pai": added,
                                   "consumed": held + [called]})
            self.assertEqual(meld["consumed"], held)
            self.assertEqual(get_pon_tiles({"pai": called, "consumed": consumed}), consumed)

    def test_added_kan_generation_and_execution_agree_for_red_fives(self):
        for called, added in (("5mr", "5m"), ("5m", "5mr")):
            with self.subTest(called=called, added=added):
                snapshot = create_initial_snapshot(create_match_state(1, "test"))
                snapshot["hands"][0] = [added, "1m"]
                snapshot["melds"][0] = [{"type": "pon", "pai": called,
                                         "consumed": ["5m", "5m"], "target": 3}]
                snapshot["actionHistory"] = [{"type": "tsumo", "actor": 0, "pai": added}]
                snapshot_state.persist(snapshot)
                candidate = get_legal_kan_actions(snapshot, 0)[0]
                self.assertEqual(candidate["consumed"], ["5m", "5m", called])
                actions = RoundActions(Mock(), Mock())
                actions.build_kan_reaction_window = Mock(return_value={})
                actions.start_kakan_reaction_window(snapshot, {**candidate, "actor": 0})
                self.assertEqual(snapshot["actionHistory"][-1]["consumed"], candidate["consumed"])
                actions.finalize_kakan_resolution(snapshot)
                self.assertEqual(len(snapshot["melds"][0]), 1)
                self.assertEqual(snapshot["melds"][0][0]["type"], "kakan")
                self.assertEqual(snapshot["melds"][0][0]["consumed"], candidate["consumed"])
