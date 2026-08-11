import copy
import unittest
from unittest import mock

import service


def reaction_game(*, second_responder=False):
    game = service.create_empty_game(424242)
    root_id = game["currentNodeId"]
    root = game["nodes"][root_id]
    snapshot = root["snapshot"]
    snapshot["phase"] = "reaction_window"
    snapshot["currentActor"] = 0
    snapshot["hands"][1] = [
        "2m", "3m", "4p", "5p", "6p", "7p", "8p",
        "1s", "2s", "3s", "E", "S", "W",
    ]
    snapshot["hands"][2] = [
        "1m", "1m", "1m", "4m", "5m", "6m", "7m", "8m",
        "1p", "2p", "3p", "E", "S",
    ]
    discard = {
        "actor": 0,
        "pai": "1m",
        "targetActor": 1,
        "tsumogiri": False,
    }
    snapshot["pendingDiscard"] = copy.deepcopy(discard)
    reactions = [
        {
            "seat": 1,
            "response": {"type": "none", "actor": 1, "variant": "none"},
            "priority": 0,
        },
    ]
    if second_responder:
        reactions.append({
            "seat": 2,
            "response": {"type": "none", "actor": 2, "variant": "none"},
            "priority": 0,
        })
    reactions.append({
        "seat": 3,
        "response": {"type": "none", "actor": 3, "variant": "none"},
        "priority": 0,
    })
    snapshot["reactionWindow"] = {
        "discard": copy.deepcopy(discard),
        "reactions": reactions,
        "selected": copy.deepcopy(reactions[0]),
        "thinkingTimeS": 0.0,
    }
    service.persist_snapshot_state(snapshot)
    root["snapshot"] = snapshot
    return game, root_id


def riichi_ankan_game():
    game = service.create_empty_game(616161)
    root_id = game["currentNodeId"]
    snapshot = game["nodes"][root_id]["snapshot"]
    snapshot["phase"] = "discard"
    snapshot["currentActor"] = 0
    snapshot["riichiAccepted"] = [True, False, False, False]
    snapshot["riichiDiscardState"] = "ankan_choice"
    snapshot["hands"][0] = [
        "1m", "2m", "3m", "4m", "5m", "6m", "7m",
        "1p", "2p", "3p", "9s", "9s", "9s", "9s",
    ]
    snapshot["actionHistory"] = [{"type": "tsumo", "actor": 0, "pai": "9s"}]
    service.persist_snapshot_state(snapshot)
    kan = {
        "type": "ankan",
        "variant": "ankan:9s",
        "pai": "9s",
        "consumed": ["9s"] * 4,
        "label": "Closed Kan 9s",
    }
    return game, root_id, kan


class ReactionDecisionNodeTests(unittest.TestCase):
    def setUp(self):
        service.STATE["mode"] = "play"
        service.STATE["controlledSeat"] = 0
        service.STATE["pendingSeatSwitch"] = None
        service.STATE["gameLoaded"] = True

    def test_automatic_pass_is_recorded_before_the_draw(self):
        game, discard_id = reaction_game()
        service.STATE["game"] = game

        with mock.patch.object(service, "can_resolve_hora_reaction", return_value=False):
            service._advance_reaction_window(game, game["nodes"][discard_id]["snapshot"])

        pass_id = game["nodes"][discard_id]["mainChildId"]
        pass_node = game["nodes"][pass_id]
        draw_id = pass_node["mainChildId"]
        draw_node = game["nodes"][draw_id]

        self.assertEqual(pass_node["type"], "decision")
        self.assertEqual(pass_node["action"]["type"], "none")
        self.assertEqual(pass_node["action"]["actor"], 1)
        self.assertTrue(pass_node["action"]["decisionOnly"])
        self.assertTrue(pass_node["isDecision"])
        self.assertEqual(draw_node["action"]["type"], "tsumo")
        self.assertEqual(draw_node["action"]["actor"], 1)
        self.assertFalse(draw_node["isDecision"])
        self.assertEqual(
            service.build_legal_actions(pass_node["snapshot"], controlled_seat=1),
            [],
        )

    def test_each_known_pass_gets_its_own_decision_node(self):
        game, discard_id = reaction_game(second_responder=True)
        service.STATE["game"] = game

        with mock.patch.object(service, "can_resolve_hora_reaction", return_value=False):
            second_actions = service.build_legal_actions(
                game["nodes"][discard_id]["snapshot"],
                controlled_seat=2,
            )
            self.assertIn("daiminkan", {action["type"] for action in second_actions})
            service._advance_reaction_window(game, game["nodes"][discard_id]["snapshot"])

        first_id = game["nodes"][discard_id]["mainChildId"]
        second_id = game["nodes"][first_id]["mainChildId"]
        draw_id = game["nodes"][second_id]["mainChildId"]
        self.assertEqual(game["nodes"][first_id]["action"]["actor"], 1)
        self.assertEqual(game["nodes"][second_id]["action"]["actor"], 2)
        self.assertEqual(game["nodes"][draw_id]["action"]["type"], "tsumo")

    def test_reaction_analysis_attaches_to_the_pass_decision(self):
        game, discard_id = reaction_game()
        service.STATE["game"] = game
        with mock.patch.object(service, "can_resolve_hora_reaction", return_value=False):
            service._advance_reaction_window(game, game["nodes"][discard_id]["snapshot"])
        pass_id = game["nodes"][discard_id]["mainChildId"]
        analysis = {
            "reactionEntries": [
                {
                    "type": "chi",
                    "variant": "chi_low",
                    "label": "Chi",
                    "value": 1.0,
                    "probability": 0.7,
                    "bar": 0.7,
                    "rank": 1,
                    "isBest": True,
                },
                {
                    "type": "none",
                    "variant": "none",
                    "label": "Pass",
                    "value": 0.2,
                    "probability": 0.3,
                    "bar": 0.3,
                    "rank": 2,
                    "isBest": False,
                },
            ],
        }

        updates = service.update_cached_child_comparisons(
            game,
            game["nodes"][discard_id],
            analysis,
            1,
        )

        self.assertEqual(updates[0]["id"], pass_id)
        self.assertEqual(game["nodes"][pass_id]["comparison"]["chosenKey"], "none")
        self.assertFalse(game["nodes"][pass_id]["comparison"]["isBest"])

    def test_non_selected_pass_precedes_the_effective_call(self):
        game, discard_id = reaction_game(second_responder=True)
        service.STATE["game"] = game
        snapshot = game["nodes"][discard_id]["snapshot"]
        pon = {
            "type": "pon",
            "actor": 2,
            "pai": "1m",
            "consumed": ["1m", "1m"],
            "variant": "pon",
        }
        snapshot["reactionWindow"]["reactions"][1] = {
            "seat": 2,
            "response": copy.deepcopy(pon),
            "priority": 2,
        }
        snapshot["reactionWindow"]["selected"] = copy.deepcopy(
            snapshot["reactionWindow"]["reactions"][1]
        )
        service.persist_snapshot_state(snapshot)

        with mock.patch.object(service, "can_resolve_hora_reaction", return_value=False):
            service._advance_reaction_window(game, snapshot)

        pass_id = game["nodes"][discard_id]["mainChildId"]
        pon_id = game["nodes"][pass_id]["mainChildId"]
        self.assertEqual(game["nodes"][pass_id]["type"], "decision")
        self.assertEqual(game["nodes"][pass_id]["action"]["actor"], 1)
        self.assertEqual(game["nodes"][pon_id]["type"], "action")
        self.assertEqual(game["nodes"][pon_id]["action"]["type"], "pon")
        self.assertEqual(game["nodes"][pon_id]["action"]["actor"], 2)

    def test_kan_reaction_pass_is_recorded_before_rinshan_draw(self):
        game = service.create_empty_game(515151)
        root_id = game["currentNodeId"]
        snapshot = game["nodes"][root_id]["snapshot"]
        snapshot["phase"] = "kan_reaction_window"
        snapshot["currentActor"] = 0
        snapshot["pendingKan"] = {"type": "kakan", "actor": 0, "pai": "1m"}
        response = {"type": "none", "actor": 1, "variant": "none"}
        snapshot["kanReactionWindow"] = {
            "kan": copy.deepcopy(snapshot["pendingKan"]),
            "reactions": [{"seat": 1, "response": response, "priority": 0}],
            "selected": {"seat": 1, "response": response, "priority": 0},
        }
        service.persist_snapshot_state(snapshot)
        service.STATE["game"] = game

        def finish_kakan(target):
            target["pendingKan"] = None
            target["kanReactionWindow"] = None
            target["pendingRinshanDraw"] = True
            target["currentActor"] = 0
            target["phase"] = "draw_or_discard"
            service.persist_snapshot_state(target)

        with (
            mock.patch.object(service, "can_resolve_hora_reaction", return_value=True),
            mock.patch.object(service, "finalize_kakan_resolution", side_effect=finish_kakan),
        ):
            service._advance_kan_reaction_window(game, snapshot)

        pass_id = game["nodes"][root_id]["mainChildId"]
        draw_id = game["nodes"][pass_id]["mainChildId"]
        self.assertEqual(game["nodes"][pass_id]["type"], "decision")
        self.assertEqual(game["nodes"][pass_id]["action"]["type"], "none")
        self.assertEqual(game["nodes"][pass_id]["action"]["actor"], 1)
        self.assertEqual(game["nodes"][draw_id]["action"]["type"], "tsumo")
        self.assertEqual(game["nodes"][draw_id]["action"]["actor"], 0)
        self.assertFalse(game["nodes"][draw_id]["isDecision"])

    def test_riichi_ankan_skip_is_recorded_before_forced_discard(self):
        game, root_id, kan = riichi_ankan_game()
        service.STATE["game"] = game

        with (
            mock.patch.object(service, "get_legal_kan_actions", return_value=[kan]),
            mock.patch.object(service, "get_ankan_candidates", return_value=["9s"]),
            mock.patch.object(service, "ensure_analysis_cached"),
        ):
            service.submit_riichi_ankan_skip()

        pass_id = game["nodes"][root_id]["mainChildId"]
        discard_id = game["nodes"][pass_id]["mainChildId"]
        self.assertEqual(game["nodes"][pass_id]["type"], "decision")
        self.assertEqual(game["nodes"][pass_id]["action"]["variant"], "skip_ankan")
        self.assertEqual(game["nodes"][discard_id]["action"]["type"], "dahai")
        self.assertTrue(game["nodes"][discard_id]["action"]["tsumogiri"])
        self.assertFalse(game["nodes"][discard_id]["isDecision"])

    def test_ai_riichi_ankan_skip_is_recorded_before_forced_discard(self):
        game, root_id, kan = riichi_ankan_game()
        service.STATE["game"] = game
        ai_discard = {
            "type": "dahai",
            "actor": 0,
            "pai": "9s",
            "tsumogiri": True,
        }

        with (
            mock.patch.object(service, "get_legal_kan_actions", return_value=[kan]),
            mock.patch.object(service, "get_ankan_candidates", return_value=["9s"]),
            mock.patch.object(service, "choose_ai_discard", return_value=ai_discard),
        ):
            service._process_ai_discard(game, game["nodes"][root_id]["snapshot"], 0)

        pass_id = game["nodes"][root_id]["mainChildId"]
        discard_id = game["nodes"][pass_id]["mainChildId"]
        self.assertEqual(game["nodes"][pass_id]["type"], "decision")
        self.assertEqual(game["nodes"][pass_id]["action"]["variant"], "skip_ankan")
        self.assertEqual(game["nodes"][discard_id]["action"]["type"], "dahai")
        self.assertFalse(game["nodes"][discard_id]["isDecision"])

    def test_collapsed_local_pass_is_repaired_once(self):
        game, discard_id = reaction_game()
        game["metadata"]["source"] = "local-environment"
        snapshot = copy.deepcopy(game["nodes"][discard_id]["snapshot"])
        service.apply_reaction_action(snapshot, snapshot["reactionWindow"]["selected"])
        service.draw_one(snapshot, 1)
        snapshot["phase"] = "discard"
        child_id = service.create_node(
            game,
            discard_id,
            {"type": "tsumo", "actor": 1, "pai": snapshot["hands"][1][-1]},
            snapshot,
        )
        game["nodes"][discard_id]["mainChildId"] = child_id

        inserted = service.repair_reaction_decision_nodes(game)
        inserted_again = service.repair_reaction_decision_nodes(game)

        pass_id = game["nodes"][discard_id]["mainChildId"]
        self.assertEqual(inserted, 1)
        self.assertEqual(inserted_again, 0)
        self.assertEqual(game["nodes"][pass_id]["type"], "decision")
        self.assertEqual(game["nodes"][pass_id]["mainChildId"], child_id)
        self.assertEqual(game["nodes"][child_id]["parentId"], pass_id)

    def test_external_effective_call_does_not_invent_other_responses(self):
        game, discard_id = reaction_game(second_responder=True)
        game["metadata"]["source"] = "mortal-report"
        snapshot = copy.deepcopy(game["nodes"][discard_id]["snapshot"])
        response = {
            "type": "pon",
            "actor": 2,
            "pai": "1m",
            "consumed": ["1m", "1m"],
            "variant": "pon",
        }
        child_id = service.create_node(game, discard_id, response, snapshot)
        game["nodes"][discard_id]["mainChildId"] = child_id

        inserted = service.repair_reaction_decision_nodes(game)

        self.assertEqual(inserted, 0)
        self.assertEqual(game["nodes"][discard_id]["mainChildId"], child_id)

    def test_external_all_pass_transition_is_safe_to_infer(self):
        game, discard_id = reaction_game()
        game["metadata"]["source"] = "mortal-report"
        snapshot = copy.deepcopy(game["nodes"][discard_id]["snapshot"])
        service.apply_reaction_action(snapshot, snapshot["reactionWindow"]["selected"])
        service.draw_one(snapshot, 1)
        snapshot["phase"] = "discard"
        child_id = service.create_node(
            game,
            discard_id,
            {"type": "tsumo", "actor": 1, "pai": snapshot["hands"][1][-1]},
            snapshot,
        )
        game["nodes"][discard_id]["mainChildId"] = child_id

        inserted = service.repair_reaction_decision_nodes(game)

        pass_id = game["nodes"][discard_id]["mainChildId"]
        self.assertEqual(inserted, 1)
        self.assertEqual(game["nodes"][pass_id]["type"], "decision")
        self.assertEqual(game["nodes"][pass_id]["action"]["source"], "inferred_reaction_pass")
        self.assertEqual(game["nodes"][pass_id]["mainChildId"], child_id)

    def test_record_round_trip_preserves_decision_node_type(self):
        game, discard_id = reaction_game()
        game["metadata"]["source"] = "local-environment"
        service.STATE["game"] = game
        with mock.patch.object(service, "can_resolve_hora_reaction", return_value=False):
            service._advance_reaction_window(game, game["nodes"][discard_id]["snapshot"])
        pass_id = game["nodes"][discard_id]["mainChildId"]
        record = service._serialize_game_record_from_parts(
            copy.deepcopy(game),
            {
                "mode": "play",
                "controlledSeat": 0,
                "visibleHands": False,
            },
        )

        restored = record["game"]
        service._hydrate_game_structure_from_record(restored, record["formatVersion"])

        self.assertEqual(restored["nodes"][pass_id]["type"], "decision")
        self.assertTrue(restored["nodes"][pass_id]["isDecision"])


if __name__ == "__main__":
    unittest.main()
