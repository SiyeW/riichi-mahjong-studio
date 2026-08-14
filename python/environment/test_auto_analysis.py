import copy
import os
import tempfile
import unittest
from collections import deque
from concurrent.futures import Future
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import auto_analysis_plan
import service


class AutoAnalysisPlanTest(unittest.TestCase):
    def setUp(self):
        service.cancel_auto_analysis(emit_progress=False)
        service.STATE["controlledSeat"] = 0
        service.STATE["nextGameId"] = 1
        service.STATE["mode"] = "research"
        service.STATE["opponentAnalysisEnabled"] = False
        service._MJAI_STREAM_CACHE.clear()
        service._LEGAL_ACTIONS_CACHE.clear()

    @staticmethod
    def _round_snapshot(template, round_index, honba=0):
        snapshot = copy.deepcopy(template)
        snapshot["roundIndex"] = round_index
        snapshot["honba"] = honba
        return snapshot

    def test_round_order_expands_next_then_previous_and_keeps_round_branches(self):
        template = service.create_empty_game(111111)["nodes"]["n_1"]["snapshot"]
        nodes = {
            "root": {
                "id": "root", "type": "root", "parentId": None,
                "children": ["a"], "mainChildId": "a", "depth": 0,
                "snapshot": self._round_snapshot(template, 0),
            },
            "a": {
                "id": "a", "type": "action", "parentId": "root",
                "children": ["b"], "mainChildId": "b", "depth": 1,
                "snapshot": self._round_snapshot(template, 0),
            },
            "b": {
                "id": "b", "type": "action", "parentId": "a",
                "children": ["x", "y"], "mainChildId": "x", "depth": 2,
                "snapshot": self._round_snapshot(template, 1),
            },
            "x": {
                "id": "x", "type": "action", "parentId": "b",
                "children": ["c"], "mainChildId": "c", "depth": 3,
                "snapshot": self._round_snapshot(template, 1),
            },
            "y": {
                "id": "y", "type": "action", "parentId": "b",
                "children": ["d"], "mainChildId": "d", "depth": 3,
                "snapshot": self._round_snapshot(template, 1),
            },
            "c": {
                "id": "c", "type": "action", "parentId": "x",
                "children": [], "mainChildId": None, "depth": 4,
                "snapshot": self._round_snapshot(template, 2),
            },
            "d": {
                "id": "d", "type": "action", "parentId": "y",
                "children": [], "mainChildId": None, "depth": 4,
                "snapshot": self._round_snapshot(template, 3),
            },
        }
        game = {"nodes": nodes, "currentNodeId": "b"}

        root_map = auto_analysis_plan.build_round_root_map(game)
        self.assertEqual(auto_analysis_plan.order_round_nodes(game, "b", root_map), ["b", "x", "y"])
        self.assertEqual(auto_analysis_plan.order_rounds(game, "b", root_map), ["b", "c", "a", "d"])

    def test_non_decision_node_still_requires_opponent_analysis(self):
        game = service.create_empty_game(222222)
        start_id = game["currentNodeId"]
        start_node = game["nodes"][start_id]
        passive_id = "n_passive"
        passive_snapshot = copy.deepcopy(start_node["snapshot"])
        passive_snapshot["currentActor"] = 1
        passive_snapshot["phase"] = "discard"
        start_node["children"] = [passive_id]
        start_node["mainChildId"] = passive_id
        game["nodes"][passive_id] = {
            "id": passive_id,
            "type": "action",
            "parentId": start_id,
            "children": [],
            "mainChildId": None,
            "action": {"type": "tsumo", "actor": 1, "pai": "1m"},
            "actor": 1,
            "snapshot": passive_snapshot,
            "analysisCache": {},
            "depth": int(start_node["depth"]) + 1,
        }

        items = service._build_auto_analysis_plan(
            game,
            0,
            service.get_action_engine_weight_path(),
        )
        passive_kinds = [item["kind"] for item in items if item["nodeId"] == passive_id]

        self.assertEqual(passive_kinds, ["opponent"])

    def test_unavailable_models_are_left_uncached_without_failures(self):
        game = service.create_empty_game(229944)
        service.STATE["game"] = game
        service.STATE["gameLoaded"] = True

        with (
            mock.patch.object(service, "_auto_analysis_kind_enabled", return_value=False),
            mock.patch.object(service._BG_EXECUTOR, "submit") as submit,
            mock.patch.object(service.OPPONENT_PREDICTIONS, "request_background_predict") as request,
        ):
            status = service.start_auto_analysis()

        self.assertEqual(status["status"], "completed")
        self.assertEqual(status["failed"], 0)
        self.assertLess(status["completed"], status["total"])
        self.assertEqual(status["message"], "可用模型分析完成")
        submit.assert_not_called()
        request.assert_not_called()

    def test_retained_model_error_is_counted_as_auto_analysis_failure(self):
        game = service.create_empty_game(229955)
        service.STATE["game"] = game
        service.STATE["gameLoaded"] = True

        def submit_immediately(function, *args):
            future = Future()
            try:
                future.set_result(function(*args))
            except Exception as exc:
                future.set_exception(exc)
            return future

        with (
            mock.patch.object(
                service,
                "_auto_analysis_kind_enabled",
                side_effect=lambda kind: kind == "decision",
            ),
            mock.patch.object(
                service,
                "_run_auto_decision_item",
                side_effect=RuntimeError("模型加载失败"),
            ),
            mock.patch.object(service._BG_EXECUTOR, "submit", side_effect=submit_immediately),
            mock.patch.object(service.OPPONENT_PREDICTIONS, "request_background_predict") as request,
        ):
            status = service.start_auto_analysis()

        self.assertEqual(status["status"], "completed")
        self.assertGreater(status["failed"], 0)
        self.assertIn("失败", status["message"])
        request.assert_not_called()

    def test_live_opponent_analysis_does_not_wait_for_decision_engine(self):
        game = service.create_empty_game(223344)
        node = game["nodes"][game["currentNodeId"]]
        snapshot = node["snapshot"]
        service.STATE["game"] = game
        service.STATE["gameLoaded"] = True
        service.STATE["mode"] = "play"
        service.STATE["opponentAnalysisEnabled"] = True

        self.assertTrue(service.get_node_legal_actions(game, node["id"]))
        with (
            mock.patch.object(service.OPPONENT_PREDICTIONS, "has_request", return_value=False),
            mock.patch.object(service.OPPONENT_PREDICTIONS, "request_predict") as request_predict,
            mock.patch.object(service, "auto_analysis_owns_item", return_value=False),
            mock.patch.object(
                service,
                "get_cached_mjai_stream_bundle",
                return_value={"events": [], "prefixHashes": [], "eventHash": 0},
            ),
        ):
            requested = service.request_current_opponent_analysis(snapshot)

        self.assertTrue(requested)
        request_predict.assert_called_once()

    def test_response_samples_model_activity_after_view_scheduling(self):
        order = []
        with (
            mock.patch.object(
                service,
                "build_view_payload",
                side_effect=lambda **_kwargs: order.append("view") or {},
            ),
            mock.patch.object(
                service,
                "build_state_payload",
                side_effect=lambda: order.append("state") or {},
            ),
        ):
            service.build_response("request", "command")

        self.assertEqual(order, ["view", "state"])

    def test_research_legal_actions_are_cached_per_node(self):
        game = service.create_empty_game(224466)
        node_id = game["currentNodeId"]

        with mock.patch.object(
            service,
            "build_legal_actions",
            wraps=service.build_legal_actions,
        ) as build:
            first = service.get_node_legal_actions(game, node_id)
            first.append({"id": "mutated"})
            second = service.get_node_legal_actions(game, node_id)
            game["nodes"][node_id]["snapshot"]["hands"][0].append("1m")
            service.get_node_legal_actions(game, node_id)

        self.assertEqual(build.call_count, 2)
        self.assertNotIn({"id": "mutated"}, second)

    def test_discard_rule_checks_share_one_player_state(self):
        game = service.create_empty_game(225577)
        snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
        snapshot["phase"] = "discard"
        snapshot["currentActor"] = 0
        player_state = SimpleNamespace(
            last_cans=SimpleNamespace(
                can_tsumo_agari=False,
                can_riichi=False,
                can_ryukyoku=False,
            ),
        )

        with (
            mock.patch.object(service, "actor_just_drew", return_value=True),
            mock.patch.object(service, "build_player_state", return_value=player_state) as build,
        ):
            service.build_legal_actions(snapshot)

        build.assert_called_once_with(snapshot, 0)

    def test_tree_skips_decision_reconstruction_for_other_seats(self):
        game = service.create_empty_game(226688)
        root_id = game["currentNodeId"]
        root = game["nodes"][root_id]
        child_id = "n_opponent"
        child_snapshot = copy.deepcopy(root["snapshot"])
        root["children"] = [child_id]
        root["mainChildId"] = child_id
        game["nodes"][child_id] = {
            "id": child_id,
            "type": "action",
            "parentId": root_id,
            "children": [],
            "mainChildId": None,
            "action": {"type": "dahai", "actor": 1, "pai": "1m"},
            "actor": 1,
            "snapshot": child_snapshot,
            "analysisCache": {},
            "depth": int(root["depth"]) + 1,
        }
        game["currentNodeId"] = child_id

        with mock.patch.object(service, "get_node_legal_actions") as legal_actions:
            tree = service.build_tree_view(game, child_id)

        legal_actions.assert_not_called()
        self.assertFalse(tree["nodes"][0]["isDecision"])
        self.assertNotIn("isDecision", game["nodes"][child_id])

    def test_comparison_updates_do_not_change_structural_tree_revision(self):
        game = service.create_empty_game(227799)
        parent = game["nodes"][game["currentNodeId"]]
        child_id = "n_child"
        parent["children"] = [child_id]
        game["nodes"][child_id] = {
            "id": child_id,
            "comparison": None,
        }
        revision = game["treeRevision"]

        with mock.patch.object(
            service,
            "_build_cached_child_comparison",
            return_value={"chosenKey": "1m"},
        ):
            updates = service.update_cached_child_comparisons(
                game,
                parent,
                {"discardEntries": []},
                0,
            )

        self.assertEqual(updates, [{"id": child_id, "comparison": {"chosenKey": "1m"}}])
        self.assertEqual(game["treeRevision"], revision)

    def test_project_config_reuses_parsed_value_until_file_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            config_path = Path(directory) / "config.json"
            config_path.write_text('{"training":{"mode":"no_review"}}', encoding="utf-8")
            with mock.patch.object(service, "PROJECT_ROOT", Path(directory)):
                service._PROJECT_CONFIG_SIGNATURE = None
                service._PROJECT_CONFIG_VALUE = {}
                with mock.patch.object(
                    service,
                    "_load_json_file",
                    wraps=service._load_json_file,
                ) as load_json:
                    first = service.load_project_config()
                    second = service.load_project_config()
                    stat = config_path.stat()
                    config_path.write_text('{"training":{"mode":"always_review"}}', encoding="utf-8")
                    os.utime(
                        config_path,
                        ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000),
                    )
                    third = service.load_project_config()

            service._PROJECT_CONFIG_SIGNATURE = None
            service._PROJECT_CONFIG_VALUE = {}

        self.assertIs(first, second)
        self.assertEqual(load_json.call_count, 2)
        self.assertEqual(third["training"]["mode"], "always_review")

    def test_training_defaults_match_desktop_settings(self):
        self.assertEqual(service.normalize_training_mode(None), "threshold_review")
        self.assertEqual(
            service.get_default_training_config()["mistakeThreshold"],
            0.25,
        )

    def test_packaged_config_uses_user_engine_selection(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend_root = root / "backend"
            portable_root = root / "portable"
            backend_root.mkdir()
            portable_root.mkdir()
            (backend_root / "config.json").write_text(
                '{"engines":{"profiles":[],"outputAssignments":{}}}',
                encoding="utf-8",
            )
            (portable_root / "config.json").write_text(
                '{"engines":{"schemaVersion":2,"profiles":[{'
                '"id":"profile.custom","weights":[{"slotId":"model",'
                '"format":"example","path":"selected.pth"}]}],'
                '"outputAssignments":{"action-recommendation":"profile.custom"}}}',
                encoding="utf-8",
            )
            with (
                mock.patch.object(service.sys, "frozen", True, create=True),
                mock.patch.object(service.sys, "executable", str(backend_root / "environment-service.exe")),
                mock.patch.object(service, "PORTABLE_ROOT", portable_root),
            ):
                service._PROJECT_CONFIG_SIGNATURE = None
                service._PROJECT_CONFIG_VALUE = {}
                config = service.load_project_config()

            service._PROJECT_CONFIG_SIGNATURE = None
            service._PROJECT_CONFIG_VALUE = {}

        self.assertEqual(
            config["engines"]["outputAssignments"]["action-recommendation"],
            "profile.custom",
        )
        self.assertEqual(
            config["engines"]["profiles"][0]["weights"][0]["path"],
            "selected.pth",
        )

    def test_action_engine_configuration_comes_from_assigned_profile(self):
        config = {
            "engines": {
                "profiles": [{
                    "id": "profile.custom",
                    "engineId": "example.decision-engine",
                    "engineVersion": "2.0.0",
                    "enginePath": "C:\\engine.exe",
                    "weights": [{
                        "slotId": "model",
                        "format": "example-checkpoint",
                        "path": "C:\\model.bin",
                    }],
                }],
                "outputAssignments": {
                    "action-recommendation": "profile.custom",
                },
            },
        }
        with mock.patch.object(
            service.ACTION_RECOMMENDATIONS,
            "configure_profile",
        ) as configure:
            service.configure_action_recommendation_engine(config)

        self.assertEqual(
            configure.call_args.kwargs["profile_id"],
            "profile.custom",
        )
        self.assertEqual(
            configure.call_args.kwargs["engine_id"],
            "example.decision-engine",
        )
        self.assertEqual(configure.call_args.kwargs["model_path"], "C:\\model.bin")

    def test_hidden_and_ground_truth_streams_are_cached_separately(self):
        game = service.create_empty_game(232323)
        node_id = game["currentNodeId"]

        hidden = service.get_cached_mjai_stream_bundle(game, node_id, 0)
        revealed = service.get_cached_mjai_stream_bundle(
            game,
            node_id,
            0,
            reveal_all=True,
        )

        self.assertTrue(all(tile == "?" for tile in hidden["events"][0]["tehais"][1]))
        self.assertFalse(any(tile == "?" for tile in revealed["events"][0]["tehais"][1]))
        self.assertNotEqual(hidden["eventHash"], revealed["eventHash"])
        self.assertEqual(
            {cache_key[3] for cache_key in service._MJAI_STREAM_CACHE},
            {False, True},
        )

    def test_scheduler_writes_both_model_caches_and_completes(self):
        game = service.create_empty_game(333333)
        service.STATE["game"] = game
        service.STATE["gameLoaded"] = True
        service.STATE["controlledSeat"] = 0

        def submit_immediately(function, *args):
            future = Future()
            try:
                future.set_result(function(*args))
            except Exception as exc:  # pragma: no cover - mirrors executor behavior
                future.set_exception(exc)
            return future

        def complete_opponent_analysis(_snapshot, _seat, context=None, on_complete=None, **_streams):
            on_complete({
                "predictions": {"opponents": {}, "ron_wait": {}},
                "ground_truth": {"opponents": {}, "ron_wait": {}},
                "context": copy.deepcopy(context or {}),
                "status": "ready",
            })
            return True

        decision_result = {
            "model": "example-decision",
            "seat": 0,
            "discardEntries": [],
        }
        with (
            mock.patch.object(service, "emit"),
            mock.patch.object(service, "_auto_analysis_kind_enabled", return_value=True),
            mock.patch.object(service, "_run_auto_decision_item", return_value=decision_result),
            mock.patch.object(service._BG_EXECUTOR, "submit", side_effect=submit_immediately),
            mock.patch.object(
                service.OPPONENT_PREDICTIONS,
                "request_background_predict",
                side_effect=complete_opponent_analysis,
            ),
        ):
            status = service.start_auto_analysis()

        self.assertEqual(status["status"], "completed")
        self.assertEqual(status["completed"], status["total"])
        self.assertGreaterEqual(status["analyzed"], 2)
        node = game["nodes"][game["currentNodeId"]]
        self.assertTrue(node["analysisCache"])
        self.assertTrue(node[service.OPPONENT_ANALYSIS_CACHE_FIELD])

    def test_scheduler_prepares_opponent_streams_without_holding_state_lock(self):
        game = service.create_empty_game(343434)
        node_id = game["currentNodeId"]
        item = {
            "kind": "opponent",
            "nodeId": node_id,
            "cacheKey": "test",
            "cached": False,
        }
        service.STATE["game"] = game
        service.STATE["gameLoaded"] = True
        service._AUTO_ANALYSIS_CONTEXT = {
            "generation": 1,
            "game": game,
            "gameId": game["gameId"],
            "seat": 0,
            "modelPath": "test",
            "pending": deque([item]),
            "known": {auto_analysis_plan.item_key(item)},
            "attempted": set(),
            "treeRevision": int(game["treeRevision"]),
        }
        service._AUTO_ANALYSIS_STATE.update({
            "status": "running",
            "currentNodeId": None,
            "currentModel": None,
        })
        lock_was_available = []

        def prepare_stream(_game, _node_id, _seat, **_options):
            acquired = service._STATE_LOCK.acquire(blocking=False)
            lock_was_available.append(acquired)
            if acquired:
                service._STATE_LOCK.release()
            return {"events": [], "prefixHashes": [0], "eventHash": 0}

        with (
            mock.patch.object(service, "_auto_analysis_kind_enabled", return_value=True),
            mock.patch.object(service, "get_cached_mjai_stream_bundle", side_effect=prepare_stream),
            mock.patch.object(service, "_emit_auto_analysis_progress"),
            mock.patch.object(service.OPPONENT_PREDICTIONS, "request_background_predict", return_value=True),
        ):
            service._schedule_next_auto_analysis_item(1)

        self.assertEqual(lock_was_available, [True, True])

    def test_timeline_is_stable_and_tracks_cache_changes(self):
        game = service.create_empty_game(444444)
        root_id = game["currentNodeId"]
        root = game["nodes"][root_id]
        child_id = "n_passive"
        child_snapshot = copy.deepcopy(root["snapshot"])
        child_snapshot["currentActor"] = 1
        root["children"] = [child_id]
        root["mainChildId"] = child_id
        game["nodes"][child_id] = {
            "id": child_id,
            "type": "action",
            "parentId": root_id,
            "children": [],
            "mainChildId": None,
            "action": {"type": "tsumo", "actor": 1, "pai": "1m"},
            "actor": 1,
            "snapshot": child_snapshot,
            "analysisCache": {},
            "depth": int(root["depth"]) + 1,
        }
        service.STATE["game"] = game
        service.STATE["gameLoaded"] = True
        service._invalidate_auto_analysis_timeline()

        first = service.get_auto_analysis_status()
        game["currentNodeId"] = child_id
        second = service.get_auto_analysis_status()

        self.assertEqual(first["timeline"], second["timeline"])
        self.assertTrue(first["timeline"].endswith("o"))

        decision_index = next(
            index
            for index, item in enumerate(service._AUTO_ANALYSIS_TIMELINE["items"])
            if item["kind"] == "decision"
        )
        decision_item = service._AUTO_ANALYSIS_TIMELINE["items"][decision_index]
        root["analysisCache"][decision_item["cacheKey"]] = {"error": None}
        service._set_auto_analysis_timeline_cached("decision", root_id, True)
        cached = service.get_auto_analysis_status()

        self.assertEqual(cached["timeline"][decision_index], "M")
        self.assertEqual(cached["timelineReady"], first["timelineReady"] + 1)

    def test_navigation_runs_current_node_then_restarts_round_from_beginning(self):
        game = service.create_empty_game(555555)
        root_id = game["currentNodeId"]
        root = game["nodes"][root_id]

        def append_node(parent_id, node_id, *, main=True):
            parent = game["nodes"][parent_id]
            snapshot = copy.deepcopy(parent["snapshot"])
            game["nodes"][node_id] = {
                "id": node_id,
                "type": "action",
                "parentId": parent_id,
                "children": [],
                "mainChildId": None,
                "action": {"type": "tsumo", "actor": 1, "pai": "1m"},
                "actor": 1,
                "snapshot": snapshot,
                "analysisCache": {},
                "depth": int(parent["depth"]) + 1,
            }
            parent["children"].append(node_id)
            if main:
                parent["mainChildId"] = node_id
            return node_id

        before_id = append_node(root_id, "before")
        current_id = append_node(before_id, "current")
        forward_id = append_node(current_id, "forward")
        side_id = append_node(before_id, "side", main=False)
        far_id = append_node(forward_id, "far")
        game["currentNodeId"] = current_id
        service.STATE["game"] = game
        service.STATE["gameLoaded"] = True

        def opponent_item(node_id):
            return {
                "kind": "opponent",
                "nodeId": node_id,
                "cacheKey": "test",
                "cached": False,
            }

        def decision_item(node_id):
            return {
                "kind": "decision",
                "nodeId": node_id,
                "cacheKey": "test",
                "cached": False,
            }

        pending = deque([
            opponent_item(far_id),
            opponent_item(side_id),
            opponent_item(root_id),
            opponent_item(forward_id),
            decision_item(current_id),
            opponent_item(current_id),
            opponent_item(before_id),
        ])
        service._AUTO_ANALYSIS_CONTEXT = {
            "generation": 1,
            "game": game,
            "gameId": game["gameId"],
            "seat": 0,
            "modelPath": "test",
            "pending": pending,
            "known": {auto_analysis_plan.item_key(item) for item in pending},
            "attempted": set(),
            "treeRevision": int(game["treeRevision"]),
        }
        service._AUTO_ANALYSIS_STATE.update({
            "status": "running",
            "completed": 0,
            "total": len(pending),
            "cached": 0,
            "analyzed": 0,
            "failed": 0,
            "currentNodeId": None,
            "currentModel": None,
            "message": "",
        })

        with mock.patch.object(
            service,
            "_auto_analysis_kind_enabled",
            return_value=True,
        ):
            service.reprioritize_auto_analysis_from_node(game, current_id)

        ordered_items = [
            (item["nodeId"], item["kind"])
            for item in service._AUTO_ANALYSIS_CONTEXT["pending"]
        ]
        self.assertEqual(
            ordered_items,
            [
                (current_id, "decision"),
                (current_id, "opponent"),
                (root_id, "opponent"),
                (before_id, "opponent"),
                (forward_id, "opponent"),
                (far_id, "opponent"),
                (side_id, "opponent"),
            ],
        )
        self.assertTrue(service.auto_analysis_owns_item("decision", current_id))
        self.assertTrue(service.auto_analysis_owns_item("opponent", current_id))

    def test_wheel_focus_is_immediate_but_full_reorder_is_debounced(self):
        game = service.create_empty_game(666666)
        root_id = game["currentNodeId"]
        pending = deque([
            {"kind": "opponent", "nodeId": "later", "cacheKey": "test", "cached": False},
            {"kind": "decision", "nodeId": root_id, "cacheKey": "test", "cached": False},
            {"kind": "opponent", "nodeId": root_id, "cacheKey": "test", "cached": False},
        ])
        service._AUTO_ANALYSIS_CONTEXT = {
            "generation": 1,
            "game": game,
            "gameId": game["gameId"],
            "seat": 0,
            "modelPath": "test",
            "pending": pending,
            "known": {auto_analysis_plan.item_key(item) for item in pending},
            "attempted": set(),
            "treeRevision": int(game["treeRevision"]),
        }
        service._AUTO_ANALYSIS_STATE["status"] = "running"

        with mock.patch.object(service.threading, "Timer") as timer_type:
            timer = timer_type.return_value
            service.schedule_auto_analysis_reprioritization(game, root_id)

        ordered = [
            (item["nodeId"], item["kind"])
            for item in service._AUTO_ANALYSIS_CONTEXT["pending"]
        ]
        self.assertEqual(
            ordered,
            [(root_id, "decision"), (root_id, "opponent"), ("later", "opponent")],
        )
        timer_type.assert_called_once()
        timer.start.assert_called_once()


if __name__ == "__main__":
    unittest.main()
