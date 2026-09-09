from concurrent.futures import Future
from contextlib import ExitStack
import unittest
from unittest import mock

from rms_backend import service


class InvalidateOnEntry:
    """Deterministically model a reset that won the state lock first."""
    def __init__(self, invalidate):
        self.invalidate = invalidate

    def __enter__(self):
        self.invalidate()

    def __exit__(self, *_args):
        return False


class AnalysisCompletionRaceTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.node = {"id": "node", "analysisCache": {}}
        self.game = {"gameId": "game", "nodes": {"node": self.node}}
        self.stack.enter_context(mock.patch.dict(service.STATE, {
            "game": self.game, "controlledSeat": 0, "decisionRecommendationsEnabled": True,
        }))
        self.stack.enter_context(
            mock.patch.object(service.DECISION_ANALYSIS, "_tasks", {})
        )
        self.stack.enter_context(
            mock.patch.object(service.DECISION_ANALYSIS, "_completed", set())
        )
        self.stack.enter_context(
            mock.patch.object(service.ENGINE_MANAGEMENT, "_decision_cache_epoch", 0)
        )
        self.stack.enter_context(
            mock.patch.object(service.ENGINE_MANAGEMENT, "_opponent_cache_epoch", 0)
        )
        for name, result in [
            ("play_prefetch_owns", False),
            ("auto_analysis_owns", False),
            ("build_mjai_stream_bundle", {}),
            ("build_legal_actions", []),
            ("set_timeline_cached", None),
            ("build_state", {}),
        ]:
            self.stack.enter_context(
                mock.patch.object(
                    service.DECISION_ANALYSIS.dependencies,
                    name,
                    return_value=result,
                )
            )
        self.stack.enter_context(
            mock.patch.object(service.DECISION_ANALYSIS, "cache_key", return_value="key")
        )
        self.stack.enter_context(
            mock.patch.object(
                service.DECISION_ANALYSIS,
                "update_child_comparisons",
                return_value=[],
            )
        )
        self.stack.enter_context(
            mock.patch.object(service.ENGINE_MANAGEMENT, "action_weight_path", return_value="")
        )
        self.store = self.stack.enter_context(
            mock.patch.object(service.DECISION_ANALYSIS, "store", return_value={})
        )
        self.emit = self.stack.enter_context(
            mock.patch.object(service.DECISION_ANALYSIS.dependencies, "emit")
        )

    def submit(self, future):
        with mock.patch.object(
            service.DECISION_ANALYSIS.executor,
            "submit",
            return_value=future,
        ):
            service.DECISION_ANALYSIS.submit_background(
                self.node,
                {"phase": "discard"},
            )

    def test_already_finished_task_is_not_left_in_running_registry(self):
        future = Future()
        future.set_result({"analysis": {"seat": 0}})
        self.submit(future)
        self.assertFalse(service.DECISION_ANALYSIS._tasks)
        self.assertEqual(len(service.DECISION_ANALYSIS._completed), 1)
        self.store.assert_called_once()
        ready = [call.args[0] for call in self.emit.call_args_list if call.args[0]["type"] == "analysis_ready"]
        self.assertEqual(
            ready[0]["cacheEpoch"],
            service.ENGINE_MANAGEMENT.decision_cache_epoch,
        )

    def test_failed_task_is_removed_without_marking_it_completed(self):
        future = Future()
        self.submit(future)
        future.set_exception(RuntimeError("engine failed"))
        self.assertFalse(service.DECISION_ANALYSIS._tasks)
        self.assertFalse(service.DECISION_ANALYSIS._completed)
        self.store.assert_not_called()

    def test_epoch_is_checked_after_acquiring_the_state_lock(self):
        future = Future()
        self.submit(future)
        lock = InvalidateOnEntry(
            lambda: setattr(service.ENGINE_MANAGEMENT, "_decision_cache_epoch", 1)
        )
        with mock.patch.object(service.DECISION_ANALYSIS, "state_lock", lock):
            future.set_result({"analysis": {"seat": 0}})
        self.store.assert_not_called()
        self.emit.assert_not_called()
        self.assertFalse(service.DECISION_ANALYSIS._tasks)
        self.assertFalse(service.DECISION_ANALYSIS._completed)

    def test_old_game_completion_cannot_write_or_emit(self):
        future = Future()
        self.submit(future)
        service.STATE["game"] = {"gameId": "new", "nodes": {}}
        future.set_result({"analysis": {"seat": 0}})
        self.store.assert_not_called()
        self.emit.assert_not_called()

    def test_replaced_node_completion_cannot_write_or_emit(self):
        future = Future()
        self.submit(future)
        self.game["nodes"]["node"] = {"id": "node"}
        future.set_result({"analysis": {"seat": 0}})
        self.store.assert_not_called()
        self.emit.assert_not_called()

    def test_old_completion_does_not_remove_a_replacement_task(self):
        future = Future()
        self.submit(future)
        key = next(iter(service.DECISION_ANALYSIS._tasks))
        replacement = Future()
        service.DECISION_ANALYSIS._tasks[key] = replacement
        service.ENGINE_MANAGEMENT._decision_cache_epoch += 1
        future.set_result({"analysis": {"seat": 0}})
        self.assertIs(service.DECISION_ANALYSIS._tasks[key], replacement)
        self.assertFalse(service.DECISION_ANALYSIS._completed)

    def test_opponent_epoch_is_checked_inside_the_state_lock(self):
        result = {"status": "ready", "context": {"cacheEpoch": 0}}
        lock = InvalidateOnEntry(
            lambda: setattr(service.ENGINE_MANAGEMENT, "_opponent_cache_epoch", 1)
        )
        with (
            mock.patch.object(service.OPPONENT_ANALYSIS, "state_lock", lock),
            mock.patch.object(
                service.opponent_analysis_session,
                "compact_opponent_analysis",
            ) as compact,
        ):
            self.assertFalse(
                service.OPPONENT_ANALYSIS.cache_result(
                    result,
                    require_current=False,
                )
            )
        compact.assert_not_called()
        self.emit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
