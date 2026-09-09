import unittest
from types import SimpleNamespace
from unittest import mock

from rms_backend.analysis_cache import (
    ANALYSIS_SOURCES_FIELD,
    OPPONENT_ANALYSIS_CACHE_FIELD,
)
from rms_backend.analysis_commands import AnalysisCommands


class AnalysisCommandsTest(unittest.TestCase):
    def test_clear_caches_retires_all_loaded_analysis_state(self):
        game = {
            "gameId": "game_0001",
            "treeRevision": 4,
            "pendingReview": {"nodeId": "node"},
            ANALYSIS_SOURCES_FIELD: {"decision": {"engineId": "engine"}},
            "nodes": {
                "node": {
                    "analysisCache": {"a": {}, "b": {}},
                    OPPONENT_ANALYSIS_CACHE_FIELD: {"x": {}},
                    "comparison": {"chosen": "1m"},
                },
            },
        }
        auto_analysis = SimpleNamespace(
            cancel=mock.Mock(),
            invalidate_timeline=mock.Mock(),
        )
        play_prefetch = SimpleNamespace(cancel=mock.Mock())
        decision_analysis = SimpleNamespace(purge=mock.Mock())
        opponent_predictions = SimpleNamespace(cancel_all=mock.Mock())
        engine_management = SimpleNamespace(
            advance_cache_epochs=mock.Mock(return_value=(7, 9)),
        )
        view_builder = SimpleNamespace(
            build_state_payload=mock.Mock(return_value={"loaded": True}),
        )
        ensure_loaded = mock.Mock()
        commands = AnalysisCommands(
            state={"game": game},
            auto_analysis=auto_analysis,
            play_prefetch=play_prefetch,
            decision_analysis=decision_analysis,
            opponent_predictions=opponent_predictions,
            engine_management=engine_management,
            opponent_analysis=mock.Mock(),
            view_builder=view_builder,
            ensure_game_loaded=ensure_loaded,
            get_action_debug=mock.Mock(),
            get_opponent_debug=mock.Mock(),
            now_iso=lambda: "now",
        )

        response = commands.clear_caches("request", "clear_analysis_caches")

        self.assertEqual(response["state"], {"loaded": True})
        self.assertEqual(
            response["cleared"],
            {
                "decisionEntries": 2,
                "decisionCacheEpoch": 7,
                "opponentCacheEpoch": 9,
                "opponentEntries": 1,
                "comparisons": 1,
                "pendingReview": True,
                "treeRevision": 5,
            },
        )
        self.assertEqual(game["nodes"]["node"]["analysisCache"], {})
        self.assertNotIn(OPPONENT_ANALYSIS_CACHE_FIELD, game["nodes"]["node"])
        self.assertIsNone(game["nodes"]["node"]["comparison"])
        self.assertIsNone(game["pendingReview"])
        self.assertEqual(game[ANALYSIS_SOURCES_FIELD], {})
        ensure_loaded.assert_called_once_with()
        play_prefetch.cancel.assert_called_once_with()
        auto_analysis.cancel.assert_called_once_with("缓存已清除")
        decision_analysis.purge.assert_called_once_with("game_0001")
        opponent_predictions.cancel_all.assert_called_once_with()
        auto_analysis.invalidate_timeline.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
