from concurrent.futures import Future
from contextlib import ExitStack
import unittest
from unittest import mock

import service


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
        for name, value in [("_BG_TASKS", {}), ("_BG_COMPLETED", set()),
                            ("_DECISION_CACHE_EPOCH", 0), ("_OPPONENT_ANALYSIS_CACHE_EPOCH", 0)]:
            self.stack.enter_context(mock.patch.object(service, name, value))
        for name, result in [
            ("get_analysis_cache_key", "key"), ("play_prefetch_owns_decision", False),
            ("auto_analysis_owns_item", False), ("get_action_engine_weight_path", ""),
            ("get_cached_mjai_stream_bundle", {}), ("build_legal_actions", []),
            ("_set_auto_analysis_timeline_cached", None), ("update_cached_child_comparisons", []),
            ("build_state_payload", {}),
        ]:
            self.stack.enter_context(mock.patch.object(service, name, return_value=result))
        self.store = self.stack.enter_context(mock.patch.object(service, "_store_decision_analysis", return_value={}))
        self.emit = self.stack.enter_context(mock.patch.object(service, "emit"))

    def submit(self, future):
        with mock.patch.object(service._BG_EXECUTOR, "submit", return_value=future):
            service._submit_background_analysis(self.node, {"phase": "discard"})

    def test_already_finished_task_is_not_left_in_running_registry(self):
        future = Future()
        future.set_result({"analysis": {"seat": 0}})
        self.submit(future)
        self.assertFalse(service._BG_TASKS)
        self.assertEqual(len(service._BG_COMPLETED), 1)
        self.store.assert_called_once()
        ready = [call.args[0] for call in self.emit.call_args_list if call.args[0]["type"] == "analysis_ready"]
        self.assertEqual(ready[0]["cacheEpoch"], service._DECISION_CACHE_EPOCH)

    def test_failed_task_is_removed_without_marking_it_completed(self):
        future = Future()
        self.submit(future)
        future.set_exception(RuntimeError("engine failed"))
        self.assertFalse(service._BG_TASKS)
        self.assertFalse(service._BG_COMPLETED)
        self.store.assert_not_called()

    def test_epoch_is_checked_after_acquiring_the_state_lock(self):
        future = Future()
        self.submit(future)
        lock = InvalidateOnEntry(lambda: setattr(service, "_DECISION_CACHE_EPOCH", 1))
        with mock.patch.object(service, "_STATE_LOCK", lock):
            future.set_result({"analysis": {"seat": 0}})
        self.store.assert_not_called()
        self.emit.assert_not_called()
        self.assertFalse(service._BG_TASKS)
        self.assertFalse(service._BG_COMPLETED)

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
        key = next(iter(service._BG_TASKS))
        replacement = Future()
        service._BG_TASKS[key] = replacement
        service._DECISION_CACHE_EPOCH += 1
        future.set_result({"analysis": {"seat": 0}})
        self.assertIs(service._BG_TASKS[key], replacement)
        self.assertFalse(service._BG_COMPLETED)

    def test_opponent_epoch_is_checked_inside_the_state_lock(self):
        result = {"status": "ready", "context": {"cacheEpoch": 0}}
        lock = InvalidateOnEntry(lambda: setattr(service, "_OPPONENT_ANALYSIS_CACHE_EPOCH", 1))
        with (mock.patch.object(service, "_STATE_LOCK", lock),
              mock.patch.object(service, "compact_opponent_analysis") as compact):
            self.assertFalse(service._cache_opponent_analysis_result(result, require_current=False))
        compact.assert_not_called()
        self.emit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
