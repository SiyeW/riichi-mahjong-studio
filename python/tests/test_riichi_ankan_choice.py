import unittest
from unittest import mock

from rms_backend import service


class RiichiAnkanChoiceTests(unittest.TestCase):
    def setUp(self):
        self.previous = dict(service.STATE)
        self.game = service.create_empty_game(616162)
        service.STATE.update(game=self.game, gameLoaded=True, controlledSeat=0,
                             mode="play", decisionRecommendationsEnabled=False,
                             opponentAnalysisEnabled=False)
        self.node_id = self.game["currentNodeId"]
        self.snapshot = self.game["nodes"][self.node_id]["snapshot"]
        self.snapshot.update(phase="discard", currentActor=0, riichiDiscardState=None)
        self.snapshot["hands"][0] = [
            "1m", "2m", "3m", "4m", "5m", "4s", "4s", "4s",
            "5s", "6s", "7s", "E", "E", "4s",
        ]
        self.snapshot["riichiAccepted"] = [True, False, False, False]
        self.snapshot["actionHistory"] = [
            {"type": "reach", "actor": 0}, {"type": "reach_accepted", "actor": 0},
            {"type": "tsumo", "actor": 0, "pai": "4s"},
        ]
        service.persist_snapshot_state(self.snapshot)

    def tearDown(self):
        service.STATE.clear()
        service.STATE.update(self.previous)
        service.LEGAL_ACTIONS.clear_cache()

    def test_legal_kan_always_includes_skip_without_timing_marker(self):
        for timing in (None, "ankan_choice"):
            with self.subTest(timing=timing):
                self.snapshot["riichiDiscardState"] = timing
                actions = service.get_node_legal_actions(self.game, self.node_id)
                self.assertEqual([a["type"] for a in actions], ["ankan", "none"])
                self.assertEqual(actions[-1]["pai"], "4s")
                self.assertTrue(actions[-1]["tsumogiri"])

    def test_skip_without_timing_marker_discards_drawn_tile_and_keeps_triplet(self):
        with mock.patch.object(service.DECISION_ANALYSIS, "ensure_cached"):
            service.REVIEW_SESSION.submit_riichi_ankan_skip()
        discard = self.game["nodes"][self.game["currentNodeId"]]
        skipped = self.game["nodes"][discard["parentId"]]
        self.assertEqual(skipped["action"]["variant"], "skip_ankan")
        self.assertEqual(service.build_legal_actions(skipped["snapshot"]), [])
        self.assertEqual(discard["action"]["type"], "dahai")
        self.assertEqual(discard["action"]["pai"], "4s")
        self.assertTrue(discard["action"]["tsumogiri"])
        self.assertFalse(discard["isDecision"])
        self.assertEqual(discard["snapshot"]["hands"][0].count("4s"), 3)
        self.assertEqual(discard["snapshot"]["melds"][0], [])
        skipped["snapshot"]["riichiDiscardState"] = None
        self.assertEqual(service.get_node_legal_actions(self.game, skipped["id"]), [])

    def test_tsumo_does_not_hide_kan_or_skip(self):
        with mock.patch.object(service, "can_declare_tsumo", return_value=True):
            actions = service.build_legal_actions(self.snapshot)
        self.assertEqual([a["type"] for a in actions], ["hora", "ankan", "none"])

    def test_changed_wait_does_not_offer_kan_or_skip(self):
        self.snapshot["hands"][0] = [
            "1m", "2m", "3m", "4m", "5m", "6m", "4s", "4s",
            "4s", "5s", "E", "E", "E", "4s",
        ]
        service.persist_snapshot_state(self.snapshot)
        self.assertEqual(service.build_legal_actions(self.snapshot), [])
