import copy
import unittest
from collections import deque
from unittest import mock

import play_prefetch_runtime
import service


class PlayPrefetchTest(unittest.TestCase):
    def setUp(self):
        service.cancel_play_prefetch()
        service.STATE["mode"] = "play"
        service.STATE["controlledSeat"] = 0
        service.STATE["pendingSeatSwitch"] = None
        service.STATE["gameLoaded"] = True
        service.STATE["opponentAnalysisEnabled"] = False
        service.STATE["decisionRecommendationsEnabled"] = True
        service.STATE["game"] = service.create_empty_game(818181)

    def tearDown(self):
        service.cancel_play_prefetch()
        service.PLAY_PREFETCH_RUNTIME.local.game = None

    def _install_context(self, draft_game):
        game = service.STATE["game"]
        base_node_id = game["currentNodeId"]
        context = {
            "generation": 101,
            "gameId": game["gameId"],
            "seat": 0,
            "modelPath": "test-model",
            "draftGame": draft_game,
            "steps": deque(),
            "nodeIdMap": {base_node_id: base_node_id},
            "committedNodeIds": {base_node_id},
            "opponentPending": set(),
            "opponentResults": {},
            "decisionPending": set(),
            "decisionResults": {},
            "running": True,
            "finished": False,
            "error": None,
        }
        service.PLAY_PREFETCH_RUNTIME.context = context
        service.PLAY_PREFETCH_RUNTIME.generation = context["generation"]
        return context

    def test_play_discard_defers_reaction_models(self):
        snapshot = service.get_current_snapshot()
        snapshot["phase"] = "discard"
        snapshot["currentActor"] = 0
        tile = snapshot["hands"][0][0]

        with mock.patch.object(service, "evaluate_reactions") as evaluate:
            next_snapshot, _action = service.create_user_discard_child_snapshot(
                snapshot,
                tile,
            )

        evaluate.assert_not_called()
        self.assertIsNone(next_snapshot["reactionWindow"])

    def test_legal_actions_mark_only_the_exact_drawn_tile_as_tsumogiri(self):
        snapshot = copy.deepcopy(service.get_current_snapshot())
        snapshot["phase"] = "discard"
        snapshot["currentActor"] = 0
        snapshot["hands"][0] = [
            "1m", "1m", "2m", "2m", "3m", "3m",
            "4m", "4m", "6m", "6m", "7m", "7m",
            "5p", "5pr",
        ]
        snapshot["actionHistory"] = [
            {"type": "tsumo", "actor": 0, "pai": "5pr"},
        ]

        with (
            mock.patch.object(service, "build_player_state", return_value={}),
            mock.patch.object(service, "can_declare_tsumo", return_value=False),
            mock.patch.object(service, "get_legal_kan_actions", return_value=[]),
            mock.patch.object(service, "can_declare_riichi", return_value=False),
            mock.patch.object(service, "can_declare_kyuushu_kyuuhai", return_value=False),
        ):
            actions = service.build_legal_actions(snapshot, controlled_seat=0)

        regular_five = next(action for action in actions if action.get("pai") == "5p")
        red_five = next(action for action in actions if action.get("pai") == "5pr")
        self.assertNotIn("tsumogiri", regular_five)
        self.assertTrue(red_five["tsumogiri"])

    def test_riichi_ankan_skip_describes_the_forced_tsumogiri(self):
        snapshot = copy.deepcopy(service.get_current_snapshot())
        snapshot["phase"] = "discard"
        snapshot["currentActor"] = 0
        snapshot["riichiAccepted"] = [True, False, False, False]
        snapshot["riichiDiscardState"] = "ankan_choice"
        snapshot["actionHistory"] = [{"type": "tsumo", "actor": 0, "pai": "9s"}]
        kan = {
            "type": "ankan",
            "variant": "ankan:9s",
            "pai": "9s",
            "consumed": ["9s"] * 4,
            "label": "Closed Kan 9s",
        }

        with (
            mock.patch.object(service, "get_legal_kan_actions", return_value=[kan]),
            mock.patch.object(service, "get_ankan_candidates", return_value=["9s"]),
        ):
            actions = service.build_legal_actions(snapshot, controlled_seat=0)

        skip = next(action for action in actions if action["type"] == "none")
        self.assertEqual(skip["variant"], "skip_ankan")
        self.assertEqual(skip["pai"], "9s")
        self.assertTrue(skip["tsumogiri"])

    def test_stale_riichi_ankan_state_does_not_offer_an_orphan_skip(self):
        snapshot = copy.deepcopy(service.get_current_snapshot())
        snapshot["phase"] = "discard"
        snapshot["currentActor"] = 0
        snapshot["riichiAccepted"] = [True, False, False, False]
        snapshot["riichiDiscardState"] = "ankan_choice"

        with (
            mock.patch.object(service, "get_legal_kan_actions", return_value=[]),
            mock.patch.object(service, "get_ankan_candidates", return_value=[]),
        ):
            actions = service.build_legal_actions(snapshot, controlled_seat=0)

        self.assertEqual(actions, [])

    def test_committing_riichi_ankan_consumes_the_choice_state(self):
        snapshot = copy.deepcopy(service.get_current_snapshot())
        snapshot["phase"] = "discard"
        snapshot["currentActor"] = 0
        snapshot["riichiAccepted"] = [True, False, False, False]
        snapshot["riichiDiscardState"] = "ankan_choice"
        snapshot["hands"][0] = ["1m", "1m", "1m", "1m"]
        service.persist_snapshot_state(snapshot)
        response = {
            "type": "ankan",
            "variant": "ankan:1m",
            "actor": 0,
            "pai": "1m",
            "consumed": ["1m"] * 4,
        }

        service.apply_self_kan_action(snapshot, response)

        self.assertIsNone(snapshot["riichiDiscardState"])
        self.assertTrue(snapshot["pendingRinshanDraw"])
        self.assertEqual(snapshot["phase"], "draw_or_discard")

    def test_ai_discard_node_preserves_tsumogiri_identity(self):
        game = service.STATE["game"]
        snapshot = service.get_current_snapshot()
        actor = 1
        snapshot["phase"] = "discard"
        snapshot["currentActor"] = actor
        snapshot["hands"][actor] = [
            "1m", "2m", "3m", "4m", "5m", "6m", "7m",
            "8m", "9m", "1p", "2p", "3p", "4p", "F",
        ]
        snapshot["actionHistory"] = [{"type": "tsumo", "actor": actor, "pai": "F"}]
        service.persist_snapshot_state(snapshot)

        with mock.patch.object(
            service,
            "choose_ai_action_for_current_node",
            return_value={"type": "dahai", "actor": actor, "pai": "F", "tsumogiri": True},
        ):
            service._process_ai_discard(game, snapshot, actor)

        child = game["nodes"][game["currentNodeId"]]
        self.assertTrue(child["action"]["tsumogiri"])
        self.assertTrue(child["snapshot"]["lastAction"]["tsumogiri"])

    def test_ai_riichi_node_uses_declare_variant(self):
        game = service.STATE["game"]
        snapshot = service.get_current_snapshot()
        actor = 1
        snapshot["phase"] = "discard"
        snapshot["currentActor"] = actor

        with mock.patch.object(
            service,
            "choose_ai_discard",
            return_value={"type": "reach", "actor": actor},
        ):
            service._process_ai_discard(game, snapshot, actor)

        child = game["nodes"][game["currentNodeId"]]
        self.assertEqual(child["action"]["type"], "reach")
        self.assertEqual(child["action"]["variant"], "declare")

    def test_duplicate_drawn_tile_preserves_explicit_hand_discard(self):
        snapshot = copy.deepcopy(service.get_current_snapshot())
        actor = 1
        snapshot["hands"][actor] = ["F", "F"]
        snapshot["actionHistory"] = [{"type": "tsumo", "actor": actor, "pai": "F"}]

        self.assertFalse(service.resolve_discard_tsumogiri(snapshot, actor, "F", requested=False))
        self.assertTrue(service.resolve_discard_tsumogiri(snapshot, actor, "F", requested=True))

    def test_live_discard_reuses_matching_imported_replay_child_with_live_snapshot(self):
        game = service.STATE["game"]
        service.advance_game_flow(game)
        parent_id = game["currentNodeId"]
        snapshot = game["nodes"][parent_id]["snapshot"]
        tile = snapshot["hands"][0][0]
        replay_snapshot, replay_action = service.create_user_discard_child_snapshot(
            snapshot,
            tile,
            source="mortal-report",
            from_drawn=False,
        )
        replay_snapshot["reactionWindow"] = {
            "discard": copy.deepcopy(replay_snapshot["pendingDiscard"]),
            "reactions": [],
        }
        replay_child_id = service.create_node(
            game,
            parent_id,
            replay_action,
            replay_snapshot,
        )

        with mock.patch.object(service, "ensure_analysis_cached"):
            service.submit_discard(tile, from_drawn=False)

        live_child_id = game["currentNodeId"]
        self.assertEqual(live_child_id, replay_child_id)
        self.assertEqual(game["nodes"][live_child_id]["action"]["source"], "mortal-report")
        self.assertIsNone(game["nodes"][live_child_id]["snapshot"]["reactionWindow"])
        self.assertEqual(game["nodes"][parent_id]["children"], [replay_child_id])

    def test_display_only_reaction_window_is_recomputed_before_advance(self):
        game = service.STATE["game"]
        service.advance_game_flow(game)
        snapshot = service.get_current_snapshot()
        tile = snapshot["hands"][0][0]
        next_snapshot, action = service.create_user_discard_child_snapshot(
            snapshot,
            tile,
            source="mortal-report",
            from_drawn=False,
        )
        next_snapshot["reactionWindow"] = {
            "discard": copy.deepcopy(next_snapshot["pendingDiscard"]),
            "reactions": [],
        }
        child_id = service.create_node(
            game,
            game["currentNodeId"],
            action,
            next_snapshot,
        )
        game["currentNodeId"] = child_id
        selected = {
            "seat": 1,
            "response": {"type": "none", "actor": 1, "variant": "none"},
            "priority": 0,
        }
        resolved_window = {
            "discard": copy.deepcopy(next_snapshot["pendingDiscard"]),
            "reactions": [copy.deepcopy(selected)],
            "selected": copy.deepcopy(selected),
            "thinkingTimeS": 0.0,
        }

        with mock.patch.object(
            service,
            "evaluate_reactions",
            return_value=resolved_window,
        ) as evaluate:
            service._advance_reaction_window(game, next_snapshot)

        evaluate.assert_called_once_with(next_snapshot)
        self.assertNotEqual(game["currentNodeId"], child_id)

    def test_prefetched_step_does_not_touch_tree_until_commit(self):
        game = service.STATE["game"]
        base_node_id = game["currentNodeId"]
        original_node_ids = set(game["nodes"])
        draft_game = play_prefetch_runtime.create_draft(game)
        context = self._install_context(draft_game)

        def fake_advance(target_game):
            parent_id = target_game["currentNodeId"]
            parent_snapshot = target_game["nodes"][parent_id]["snapshot"]
            next_snapshot = copy.deepcopy(parent_snapshot)
            next_snapshot["turn"] = int(next_snapshot.get("turn", 0)) + 1
            action = {
                "type": "dahai",
                "actor": 1,
                "pai": "1m",
                "source": "test",
            }
            child_id = service.create_node(
                target_game,
                parent_id,
                action,
                next_snapshot,
            )
            service.attach_mainline(parent_id, child_id)
            target_game["currentNodeId"] = child_id
            service.promote_path_to_mainline(target_game, child_id)

        with mock.patch.object(service, "advance_game_flow", side_effect=fake_advance):
            step = service._capture_play_prefetch_step(context)

        self.assertIsNotNone(step)
        self.assertEqual(set(game["nodes"]), original_node_ids)
        self.assertEqual(game["currentNodeId"], base_node_id)

        context["steps"].append(step)
        result = service._commit_play_prefetch_step()

        self.assertTrue(result["committed"])
        self.assertEqual(len(game["nodes"]), len(original_node_ids) + 1)
        self.assertNotEqual(game["currentNodeId"], base_node_id)

    def test_state_divergence_rejects_prefetched_step(self):
        game = service.STATE["game"]
        draft_game = play_prefetch_runtime.create_draft(game)
        context = self._install_context(draft_game)
        base_node_id = game["currentNodeId"]
        before_snapshot = copy.deepcopy(game["nodes"][base_node_id]["snapshot"])
        step = {
            "beforeNodeId": base_node_id,
            "beforeSnapshot": before_snapshot,
            "afterBaseSnapshot": copy.deepcopy(before_snapshot),
            "afterNodeId": base_node_id,
            "transitionNodes": [],
            "afterMatchState": copy.deepcopy(game.get("matchState")),
        }
        context["steps"].append(step)
        game["nodes"][base_node_id]["snapshot"]["turn"] += 1

        result = service._commit_play_prefetch_step()

        self.assertIsNone(result)
        self.assertIn("diverged", context["error"])
        self.assertFalse(context["steps"])

    def test_waiting_prefetch_does_not_advance_real_game(self):
        game = service.STATE["game"]
        draft_game = play_prefetch_runtime.create_draft(game)
        self._install_context(draft_game)
        before = copy.deepcopy(game)

        result = service.advance_game_with_prefetch(game)

        self.assertFalse(result["committed"])
        self.assertTrue(result["waiting"])
        self.assertEqual(game, before)

    def test_play_state_payload_skips_hidden_auto_analysis_timeline(self):
        with mock.patch.object(service, "_ensure_auto_analysis_timeline_locked") as ensure_timeline:
            payload = service.build_state_payload(consume_thinking_time=False)

        ensure_timeline.assert_not_called()
        self.assertEqual(payload["autoAnalysis"]["timeline"], "")
        self.assertEqual(payload["autoAnalysis"]["timelineReady"], 0)

    def test_research_state_payload_builds_auto_analysis_timeline(self):
        service.STATE["mode"] = "research"
        with mock.patch.object(service, "_ensure_auto_analysis_timeline_locked") as ensure_timeline:
            service.build_state_payload(consume_thinking_time=False)

        ensure_timeline.assert_called_once()

    def test_prefetch_failure_notifies_the_current_committed_node(self):
        game = service.STATE["game"]
        base_node_id = game["currentNodeId"]
        draft_game = play_prefetch_runtime.create_draft(game)
        context = self._install_context(draft_game)

        with mock.patch.object(service, "emit") as emit:
            service._fail_play_prefetch(context, RuntimeError("test failure"))

        self.assertTrue(context["finished"])
        self.assertFalse(context["running"])
        self.assertEqual(context["error"], "test failure")
        emit.assert_called_once()
        self.assertEqual(emit.call_args.args[0]["type"], "play_prefetch_ready")
        self.assertEqual(emit.call_args.args[0]["nodeId"], base_node_id)

    def test_real_flow_prefetches_until_next_user_decision(self):
        game = service.STATE["game"]
        service.STATE["decisionRecommendationsEnabled"] = False
        service.advance_game_flow(game)
        draw_node_id = game["currentNodeId"]
        snapshot = game["nodes"][draw_node_id]["snapshot"]
        self.assertEqual(snapshot["phase"], "discard")
        self.assertEqual(snapshot["currentActor"], 0)

        tile = snapshot["hands"][0][0]
        service.submit_discard(tile)
        committed_user_node_id = game["currentNodeId"]
        committed_node_count = len(game["nodes"])

        def pass_or_discard(current_snapshot, seat, *_args, **_kwargs):
            if (
                current_snapshot.get("phase") in ("discard", "reach_declaration")
                and current_snapshot.get("currentActor") == seat
            ):
                return {
                    "type": "dahai",
                    "actor": seat,
                    "pai": current_snapshot["hands"][seat][-1],
                    "meta": {"thinking_time_s": 0.0},
                }
            return {
                "type": "none",
                "actor": seat,
                "variant": "none",
                "meta": {"thinking_time_s": 0.0},
            }

        with (
            mock.patch.object(service._PLAY_PREFETCH_EXECUTOR, "submit"),
            mock.patch.object(
                service,
                "choose_ai_action_for_current_node",
                side_effect=pass_or_discard,
            ),
            mock.patch.object(
                service,
                "choose_ai_action_for_snapshot",
                side_effect=pass_or_discard,
            ),
        ):
            service.start_play_prefetch()
            context = service.PLAY_PREFETCH_RUNTIME.context
            self.assertIsNotNone(context)
            service._run_play_prefetch(context["generation"])

        self.assertTrue(context["finished"])
        self.assertGreater(len(context["steps"]), 1)
        self.assertEqual(len(game["nodes"]), committed_node_count)
        self.assertEqual(game["currentNodeId"], committed_user_node_id)

        committed_steps = 0
        while context["steps"]:
            result = service._commit_play_prefetch_step()
            self.assertIsNotNone(result)
            committed_steps += 1

        final_snapshot = service.get_current_snapshot()
        self.assertGreater(committed_steps, 1)
        self.assertEqual(final_snapshot["currentActor"], 0)
        self.assertTrue(service.build_legal_actions(final_snapshot, controlled_seat=0))


if __name__ == "__main__":
    unittest.main()
