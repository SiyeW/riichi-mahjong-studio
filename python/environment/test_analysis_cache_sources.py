import copy
import unittest
from unittest import mock

import service


class AnalysisCacheSourceTest(unittest.TestCase):
    def setUp(self):
        service.STATE["controlledSeat"] = 0
        service.STATE["nextGameId"] = 1

    def test_display_name_does_not_change_source_identity(self):
        first = service._build_analysis_source(
            "decision",
            "sha256:engine",
            "decision-analysis-v3",
            "action-recommendation@1",
            display_name="Default model",
        )
        renamed = service._build_analysis_source(
            "decision",
            "sha256:engine",
            "decision-analysis-v3",
            "action-recommendation@1",
            display_name="Renamed model",
        )

        self.assertEqual(first["id"], renamed["id"])
        self.assertEqual(first["cacheFingerprint"], renamed["cacheFingerprint"])

    def test_opponent_cache_preserves_zero_and_tiny_positive_probabilities(self):
        self.assertEqual(service._quantize_shanten_probability(0), 0.0)
        self.assertEqual(service._quantize_shanten_probability(0.000001), 0.00001)
        self.assertEqual(service._quantize_shanten_probability(0.00124), 0.0012)

    def test_empty_engine_commands_remain_unconfigured(self):
        decision_command = service._resolve_configured_engine_command(
            {
                "engineCommand": [],
                "enginePath": "",
            },
        )

        self.assertEqual(decision_command, [])

    def test_regular_view_command_does_not_reconfigure_engines(self):
        previous_game = service.STATE["game"]
        previous_loaded = service.STATE["gameLoaded"]
        service.STATE["game"] = None
        service.STATE["gameLoaded"] = False
        try:
            with (
                mock.patch.object(service, "configure_action_recommendation_engine") as decision_configure,
                mock.patch.object(service, "configure_opponent_prediction_engines") as opponent_configure,
            ):
                service.handle_command("test", "get_game_view", {})
            decision_configure.assert_not_called()
            opponent_configure.assert_not_called()
        finally:
            service.STATE["game"] = previous_game
            service.STATE["gameLoaded"] = previous_loaded

    def test_saved_engine_draft_does_not_replace_runtime_weight_path(self):
        previous_runtime = service._RUNTIME_ENGINE_SETTINGS
        service._RUNTIME_ENGINE_SETTINGS = {
            "profiles": [{
                "id": "profile.loaded",
                "weights": [{
                    "slotId": "model",
                    "format": "example",
                    "path": "C:\\loaded-model.pth",
                }],
            }],
            "outputAssignments": {
                "action-recommendation": "profile.loaded",
            },
        }
        try:
            with mock.patch.object(
                service,
                "load_project_config",
                return_value={"engines": {
                    "profiles": [{
                        "id": "profile.draft",
                        "weights": [{"slotId": "model", "path": "C:\\draft-model.pth"}],
                    }],
                    "outputAssignments": {
                        "action-recommendation": "profile.draft",
                    },
                }},
            ):
                self.assertEqual(service.get_action_engine_weight_path(), "C:\\loaded-model.pth")
        finally:
            service._RUNTIME_ENGINE_SETTINGS = previous_runtime

    def test_engine_profiles_are_resolved_directly_by_output(self):
        config = {
            "engines": {
                "profiles": [
                    {
                        "id": "decision.custom",
                        "engineId": "custom.decision",
                        "enginePath": "decision.exe",
                        "weights": [{
                            "slotId": "model",
                            "format": "decision-onnx",
                            "path": "C:\\decision.onnx",
                        }],
                        "options": {"temperature": 0.75},
                    },
                    {
                        "id": "opponent.custom",
                        "engineId": "custom.opponent",
                        "enginePath": "opponent.exe",
                        "weights": [{
                            "slotId": "model",
                            "format": "opponent-onnx",
                            "path": "C:\\opponent.onnx",
                        }],
                        "options": {"threads": 2},
                    },
                ],
                "outputAssignments": {
                    "action-recommendation": "decision.custom",
                    "opponent-shanten": "opponent.custom",
                    "opponent-deal-in-probability": "opponent.custom",
                },
            },
        }

        action = service._gateway_profile(config, "action-recommendation")
        opponent = service._gateway_profile(config, "opponent-shanten")

        self.assertEqual(action["model_path"], "C:\\decision.onnx")
        self.assertEqual(action["engine_options"], {"temperature": 0.75})
        self.assertEqual(opponent["model_path"], "C:\\opponent.onnx")
        self.assertEqual(opponent["engine_options"], {"threads": 2})

    def test_one_profile_produces_one_runtime_for_all_assigned_outputs(self):
        config = {
            "engines": {
                "profiles": [{
                    "id": "profile.unified",
                    "engineId": "example.unified",
                    "enginePath": "C:\\engine.exe",
                    "weights": [{
                        "slotId": "model",
                        "format": "example",
                        "path": "C:\\model.bin",
                    }],
                }],
                "outputAssignments": {
                    "action-recommendation": "profile.unified",
                    "opponent-shanten": "profile.unified",
                    "opponent-deal-in-probability": "profile.unified",
                },
            },
        }

        specifications = service._engine_runtime_specifications(config)

        self.assertEqual(len(specifications), 1)
        self.assertEqual(specifications[0]["profile_id"], "profile.unified")
        self.assertEqual(
            specifications[0]["enabled_outputs"],
            [
                {"id": "action-recommendation", "version": 1},
                {"id": "opponent-shanten", "version": 1},
                {"id": "opponent-deal-in-probability", "version": 1},
            ],
        )

    def test_unrecognized_cache_keys_are_discarded(self):
        game = service.create_empty_game(101010)
        node = game["nodes"][game["currentNodeId"]]
        decision_identity = "sha256:" + ("a" * 64)
        opponent_identity = "sha256:" + ("b" * 64)
        decision_result = {
            "error": None,
            "model": "Example decision model",
            "engineFingerprint": "sha256:" + ("c" * 64),
        }
        opponent_result = {
            "status": "ready",
            "engineFingerprint": opponent_identity,
            "hostPostprocessorVersion": "opponent-analysis-v3",
            "predictions": {"opponents": {}, "ron_wait": {}},
            "ground_truth": {"opponents": {}, "ron_wait": {}},
        }
        node["analysisCache"] = {
            f"v2::0::discard::{decision_identity}::decision-analysis-v1": decision_result,
        }
        node[service.OPPONENT_ANALYSIS_CACHE_FIELD] = {
            "v3::0::public::best_model.pth:100:123": opponent_result,
        }

        service._migrate_analysis_cache_storage(game)

        self.assertEqual(node["analysisCache"], {})
        self.assertEqual(node[service.OPPONENT_ANALYSIS_CACHE_FIELD], {})
        self.assertEqual(game[service._ANALYSIS_SOURCES_FIELD], {})

    def test_stale_result_remains_visible_until_current_result_succeeds(self):
        game = service.create_empty_game(202020)
        node = game["nodes"][game["currentNodeId"]]
        old_source = service._build_analysis_source(
            "decision",
            "sha256:old",
            "decision-analysis-v3",
            "action-recommendation@1",
            display_name="Old model",
        )
        current_source = service._build_analysis_source(
            "decision",
            "sha256:current",
            "decision-analysis-v3",
            "action-recommendation@1",
            display_name="Current model",
        )
        old_key = service._decision_cache_key(0, "discard", old_source)
        current_key = service._decision_cache_key(0, "discard", current_source)
        service._register_analysis_source(game, old_source)
        node["analysisCache"][old_key] = {"error": None, "discardEntries": [1]}

        stale = service._find_stale_cache_entry(
            game,
            node,
            current_key,
            "analysisCache",
        )
        self.assertEqual(stale["cacheStatus"], "stale")
        self.assertEqual(stale["cacheSource"]["displayName"], "Old model")

        current_result = {
            "error": None,
            "discardEntries": [2],
            "engineFingerprint": "sha256:runtime",
        }
        with mock.patch.object(
            service,
            "_current_decision_analysis_source",
            return_value=copy.deepcopy(current_source),
        ):
            stored = service._store_decision_analysis(
                game,
                node,
                current_key,
                current_result,
            )

        self.assertEqual(stored["discardEntries"], [2])
        self.assertNotIn("engineFingerprint", stored)
        self.assertNotIn(old_key, node["analysisCache"])
        self.assertIn(current_key, node["analysisCache"])
        self.assertEqual(
            game[service._ANALYSIS_SOURCES_FIELD][current_source["id"]]["engineFingerprint"],
            "sha256:runtime",
        )

    def test_current_opponent_request_keeps_stale_cache_visible(self):
        game = service.create_empty_game(212121)
        node = game["nodes"][game["currentNodeId"]]
        context = {
            "gameId": game["gameId"],
            "nodeId": node["id"],
            "seat": 0,
            "inputMode": "public",
            "cacheKey": "o4::0::public::o-current",
            "cacheEpoch": service._SHANTEN_CACHE_EPOCH,
        }
        node[service.OPPONENT_ANALYSIS_CACHE_FIELD] = {
            "o4::0::public::o-previous": {
                "status": "ready",
                "predictions": {"opponents": {"kamicha": [1.0]}, "ron_wait": {}},
                "ground_truth": {"opponents": {}, "ron_wait": {}},
            },
        }
        previous_game = service.STATE["game"]
        previous_loaded = service.STATE["gameLoaded"]
        previous_enabled = service.STATE["opponentAnalysisEnabled"]
        service.STATE["game"] = game
        service.STATE["gameLoaded"] = True
        service.STATE["opponentAnalysisEnabled"] = True
        try:
            with (
                mock.patch.object(service, "_current_shanten_context", return_value=context),
                mock.patch.object(
                    service.OPPONENT_PREDICTIONS,
                    "get_latest",
                    return_value={
                        "status": "loading",
                        "predictions": {},
                        "ground_truth": {},
                        "context": copy.deepcopy(context),
                    },
                ),
                mock.patch.object(service, "request_current_shanten_prediction") as request,
            ):
                result = service.get_current_shanten_analysis()
        finally:
            service.STATE["game"] = previous_game
            service.STATE["gameLoaded"] = previous_loaded
            service.STATE["opponentAnalysisEnabled"] = previous_enabled

        self.assertEqual(result["cacheStatus"], "stale")
        self.assertEqual(result["context"], context)
        request.assert_not_called()

    def test_stale_opponent_cache_starts_current_request_before_returning(self):
        game = service.create_empty_game(232323)
        node = game["nodes"][game["currentNodeId"]]
        context = {
            "gameId": game["gameId"],
            "nodeId": node["id"],
            "seat": 0,
            "inputMode": "public",
            "cacheKey": "o4::0::public::o-current",
            "cacheEpoch": service._SHANTEN_CACHE_EPOCH,
        }
        node[service.OPPONENT_ANALYSIS_CACHE_FIELD] = {
            "o4::0::public::o-previous": {
                "status": "ready",
                "predictions": {"opponents": {"kamicha": [1.0]}, "ron_wait": {}},
                "ground_truth": {"opponents": {}, "ron_wait": {}},
            },
        }
        previous_game = service.STATE["game"]
        previous_loaded = service.STATE["gameLoaded"]
        previous_enabled = service.STATE["opponentAnalysisEnabled"]
        service.STATE["game"] = game
        service.STATE["gameLoaded"] = True
        service.STATE["opponentAnalysisEnabled"] = True
        try:
            with (
                mock.patch.object(service, "_current_shanten_context", return_value=context),
                mock.patch.object(
                    service.OPPONENT_PREDICTIONS,
                    "get_latest",
                    return_value={"status": "idle", "context": {}},
                ),
                mock.patch.object(service, "request_current_shanten_prediction") as request,
            ):
                result = service.get_current_shanten_analysis()
        finally:
            service.STATE["game"] = previous_game
            service.STATE["gameLoaded"] = previous_loaded
            service.STATE["opponentAnalysisEnabled"] = previous_enabled

        self.assertEqual(result["cacheStatus"], "stale")
        request.assert_called_once_with(node["snapshot"])

    def test_auto_analysis_only_accepts_the_requested_source(self):
        game = service.create_empty_game(303030)
        node = game["nodes"][game["currentNodeId"]]
        old_source = service._build_analysis_source(
            "decision", "old", "post", "action-recommendation@1"
        )
        current_source = service._build_analysis_source(
            "decision", "current", "post", "action-recommendation@1"
        )
        old_key = service._decision_cache_key(0, "discard", old_source)
        current_key = service._decision_cache_key(0, "discard", current_source)
        node["analysisCache"][old_key] = {"error": None}
        item = {
            "kind": "decision",
            "nodeId": node["id"],
            "cacheKey": current_key,
        }

        self.assertFalse(service._auto_item_is_cached(game, item))
        node["analysisCache"][current_key] = {"error": None}
        self.assertTrue(service._auto_item_is_cached(game, item))


if __name__ == "__main__":
    unittest.main()
