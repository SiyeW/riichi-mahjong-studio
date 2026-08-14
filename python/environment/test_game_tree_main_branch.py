import copy
import unittest

import service


class MainBranchPolicyTest(unittest.TestCase):
    def setUp(self):
        self.previous_game = service.STATE.get("game")
        self.previous_loaded = service.STATE.get("gameLoaded")
        self.previous_mode = service.STATE.get("mode")
        service.STATE["mode"] = "play"
        service.STATE["gameLoaded"] = True
        service.STATE["game"] = service.create_empty_game(929292)

    def tearDown(self):
        service.STATE["game"] = self.previous_game
        service.STATE["gameLoaded"] = self.previous_loaded
        service.STATE["mode"] = self.previous_mode

    def _create_child(self, parent_id, source):
        game = service.STATE["game"]
        snapshot = copy.deepcopy(game["nodes"][parent_id]["snapshot"])
        action = {
            "type": "dahai",
            "actor": 0,
            "pai": "1m",
            "tsumogiri": source == "user",
            "source": source,
        }
        return service.create_node(game, parent_id, action, snapshot)

    def test_new_game_play_nodes_extend_an_empty_branch_end(self):
        game = service.STATE["game"]
        parent_id = game["currentNodeId"]
        child_id = self._create_child(parent_id, "user")

        service.attach_mainline(parent_id, child_id)
        service.promote_path_to_mainline(game, child_id)

        self.assertEqual(game["nodes"][parent_id]["mainChildId"], child_id)
        self.assertEqual(game["mainLeafNodeId"], child_id)

    def test_play_nodes_remain_side_branch_until_explicitly_promoted(self):
        game = service.STATE["game"]
        parent_id = game["currentNodeId"]
        original_main_id = self._create_child(parent_id, "mortal-report")
        service.attach_mainline(parent_id, original_main_id, force=True)
        service.promote_path_to_mainline(game, original_main_id, force=True)

        side_branch_id = self._create_child(parent_id, "user")
        service.attach_mainline(parent_id, side_branch_id)
        service.promote_path_to_mainline(game, side_branch_id)

        self.assertEqual(game["nodes"][parent_id]["mainChildId"], original_main_id)
        self.assertEqual(game["mainLeafNodeId"], original_main_id)

        service.set_main_branch(side_branch_id)

        self.assertEqual(game["nodes"][parent_id]["mainChildId"], side_branch_id)
        self.assertEqual(game["mainLeafNodeId"], side_branch_id)

    def test_matching_live_action_reuses_imported_main_child(self):
        game = service.STATE["game"]
        parent_id = game["currentNodeId"]
        imported_snapshot = copy.deepcopy(game["nodes"][parent_id]["snapshot"])
        imported_snapshot["turn"] = 1
        imported_action = {
            "type": "dahai",
            "actor": 1,
            "pai": "1m",
            "tsumogiri": False,
            "source": "mortal-report",
        }
        imported_id = service.create_node(game, parent_id, imported_action, imported_snapshot)
        service.attach_mainline(parent_id, imported_id, force=True)

        live_snapshot = copy.deepcopy(game["nodes"][parent_id]["snapshot"])
        live_snapshot["turn"] = 2
        live_action = {
            **imported_action,
            "source": "ai",
        }
        live_id = service.create_node(game, parent_id, live_action, live_snapshot)
        service.attach_mainline(parent_id, live_id)

        self.assertEqual(live_id, imported_id)
        self.assertEqual(game["nodes"][parent_id]["children"], [imported_id])
        self.assertEqual(game["nodes"][imported_id]["snapshot"]["turn"], 2)
        self.assertEqual(game["nodes"][parent_id]["mainChildId"], imported_id)

    def test_matching_live_hora_ignores_protocol_only_variant_and_result_fields(self):
        game = service.STATE["game"]
        parent_id = game["currentNodeId"]
        imported_snapshot = copy.deepcopy(game["nodes"][parent_id]["snapshot"])
        imported_snapshot["phase"] = "game_end"
        imported_action = {
            "type": "hora",
            "actor": 1,
            "target": 0,
            "pai": "P",
            "deltas": [-16300, 16300, 0, 0],
            "fu": None,
            "han": 8,
            "source": "mortal-report",
        }
        imported_id = service.create_node(game, parent_id, imported_action, imported_snapshot)
        service.attach_mainline(parent_id, imported_id, force=True)

        live_snapshot = copy.deepcopy(imported_snapshot)
        live_snapshot["lastAction"] = {
            "type": "hora",
            "actor": 1,
            "target": 0,
            "pai": "P",
            "fu": 50,
            "han": 8,
        }
        live_action = {
            "type": "hora",
            "actor": 1,
            "target": 0,
            "pai": "P",
            "variant": "hora",
            "label": "Ron",
            "consumed": [],
            "source": "user_reaction",
        }
        live_id = service.create_node(game, parent_id, live_action, live_snapshot)

        self.assertEqual(live_id, imported_id)
        self.assertEqual(game["nodes"][parent_id]["children"], [imported_id])
        self.assertEqual(game["nodes"][imported_id]["snapshot"]["lastAction"]["fu"], 50)

    def test_protocol_variants_do_not_split_the_same_rule_action(self):
        equivalent_pairs = [
            (
                {
                    "type": "pon",
                    "actor": 3,
                    "target": 2,
                    "pai": "C",
                    "consumed": ["C", "C"],
                    "source": "mortal-report",
                },
                {
                    "type": "pon",
                    "actor": 3,
                    "target": 2,
                    "pai": "C",
                    "consumed": ["C", "C"],
                    "variant": "pon",
                    "label": "Pon",
                    "source": "user_reaction",
                },
            ),
            (
                {"type": "reach", "actor": 0, "source": "mortal-report"},
                {"type": "reach", "actor": 0, "variant": "declare", "source": "user"},
            ),
            (
                {"type": "ryukyoku", "reasonLabel": "九種九牌", "source": "mortal-report"},
                {"type": "ryukyoku", "variant": "kyuushu_kyuuhai", "source": "user"},
            ),
        ]

        for imported_action, live_action in equivalent_pairs:
            with self.subTest(action_type=imported_action["type"]):
                self.assertEqual(
                    service._action_identity(imported_action),
                    service._action_identity(live_action),
                )

    def test_side_branch_actions_form_one_continuous_local_branch(self):
        game = service.STATE["game"]
        parent_id = game["currentNodeId"]
        original_main_id = self._create_child(parent_id, "mortal-report")
        service.attach_mainline(parent_id, original_main_id, force=True)
        service.promote_path_to_mainline(game, original_main_id, force=True)

        side_branch_id = self._create_child(parent_id, "user")
        continuation_id = self._create_child(side_branch_id, "ai")
        service.attach_mainline(parent_id, side_branch_id)
        service.attach_mainline(side_branch_id, continuation_id)
        service.promote_path_to_mainline(game, continuation_id)

        self.assertEqual(game["nodes"][parent_id]["mainChildId"], original_main_id)
        self.assertEqual(game["nodes"][side_branch_id]["mainChildId"], continuation_id)
        self.assertEqual(game["mainLeafNodeId"], original_main_id)

    def test_review_choice_occupies_branch_end_and_final_choice_replaces_it(self):
        game = service.STATE["game"]
        parent_id = game["currentNodeId"]
        proposed_id = self._create_child(parent_id, "user")
        comparison = {
            "phase": "discard",
            "chosenKey": "1m",
            "bestKey": "2m",
            "chosenPai": "1m",
            "bestPai": "2m",
            "chosenLabel": "1m",
            "bestLabel": "2m",
        }

        service.register_pending_review(game, parent_id, proposed_id, comparison)

        self.assertEqual(game["nodes"][parent_id]["mainChildId"], proposed_id)
        self.assertEqual(game["mainLeafNodeId"], proposed_id)

        chosen_id = self._create_child(parent_id, "user_review")
        replaced = service.replace_pending_review_main_child(
            game,
            parent_id,
            proposed_id,
            chosen_id,
        )

        self.assertTrue(replaced)
        self.assertEqual(game["nodes"][parent_id]["mainChildId"], chosen_id)
        self.assertEqual(game["mainLeafNodeId"], chosen_id)

    def test_legacy_branch_hole_selects_the_first_remaining_child(self):
        game = service.STATE["game"]
        parent_id = game["currentNodeId"]
        first_id = self._create_child(parent_id, "user")
        self._create_child(parent_id, "user_review")
        game["nodes"][parent_id]["mainChildId"] = None
        game["mainLeafNodeId"] = parent_id

        changed = service.repair_main_branch_links(game)

        self.assertTrue(changed)
        self.assertEqual(game["nodes"][parent_id]["mainChildId"], first_id)
        self.assertEqual(game["mainLeafNodeId"], first_id)

    def test_loaded_pending_review_prefers_its_proposed_child(self):
        game = service.STATE["game"]
        parent_id = game["currentNodeId"]
        self._create_child(parent_id, "mortal-report")
        proposed_id = self._create_child(parent_id, "user")
        game["nodes"][parent_id]["mainChildId"] = None
        game["mainLeafNodeId"] = parent_id
        game["pendingReview"] = {
            "parentNodeId": parent_id,
            "proposedNodeId": proposed_id,
        }

        service.repair_main_branch_links(game)

        self.assertEqual(game["nodes"][parent_id]["mainChildId"], proposed_id)
        self.assertEqual(game["mainLeafNodeId"], proposed_id)
