import copy
import unittest
from unittest.mock import Mock, patch

import service
from auto_analysis_runtime import AutoAnalysisRuntime
from auto_analysis_plan import item_key


class DuplicateCompletionTests(unittest.TestCase):
    def runtime(self):
        runtime = AutoAnalysisRuntime()
        runtime.context = {'generation': 1, 'attempted': set(), 'game': {}, 'seat': 0}
        runtime.status['status'] = 'running'
        return runtime

    def test_duplicate_does_not_count_again_or_clear_next_future(self):
        runtime = self.runtime()
        item = {'kind': 'decision', 'nodeId': 'one', 'cacheKey': 'key'}
        self.assertIsNotNone(runtime.complete_item(1, item, True))
        future = Mock()
        runtime.future = future
        runtime.status['currentNodeId'] = 'two'
        runtime.status['currentModel'] = 'decision'
        before = copy.deepcopy(runtime.status)
        self.assertIsNone(runtime.complete_item(1, item, False, 'duplicate error'))
        self.assertEqual(runtime.status, before)
        self.assertIs(runtime.future, future)

    def test_terminal_run_does_not_accept_completion(self):
        runtime = self.runtime()
        runtime.status['status'] = 'completed'
        before = copy.deepcopy(runtime.status)
        self.assertIsNone(runtime.complete_item(1, {}, True))
        self.assertEqual(runtime.status, before)

    def test_service_rejects_duplicate_before_cache_write_or_schedule(self):
        self.assert_service_rejects('duplicate')

    def test_service_rejects_retired_game_before_cache_write_or_schedule(self):
        self.assert_service_rejects('replaced')
        self.assert_service_rejects('closed')

    def assert_service_rejects(self, reason):
        runtime = self.runtime()
        item = {'kind': 'decision', 'nodeId': 'one', 'cacheKey': 'key'}
        if reason == 'duplicate':
            runtime.context['attempted'].add(item_key(item))
        game = {'gameId': 'test', 'nodes': {'one': {}}, 'currentNodeId': 'one'}
        runtime.context['game'] = game
        runtime.context['gameId'] = 'test'
        current_game = game if reason == 'duplicate' else {} if reason == 'replaced' else None
        with patch.dict(service.STATE, {'game': current_game}), \
             patch.object(service, 'AUTO_ANALYSIS_RUNTIME', runtime), \
             patch.object(service.DECISION_ANALYSIS, 'store') as store, \
             patch.object(service, '_schedule_next_auto_analysis_item') as schedule, \
             patch.object(service, 'emit') as emit:
            service._complete_auto_analysis_item(1, item, result={'choices': []})
        store.assert_not_called()
        schedule.assert_not_called()
        emit.assert_not_called()


if __name__ == '__main__':
    unittest.main()
