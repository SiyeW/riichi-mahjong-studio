import unittest
import sys
from concurrent.futures import Future
from unittest.mock import patch

import service
from auto_analysis_runtime import AutoAnalysisRuntime


class AutoAnalysisSubmissionFailureTests(unittest.TestCase):
    def test_immediate_completion_of_long_queue_does_not_recurse(self):
        runtime = AutoAnalysisRuntime()
        items = [{'kind': 'decision', 'nodeId': str(index), 'cacheKey': 'test', 'cached': False}
                 for index in range(1200)]
        game = {'gameId': 'test', 'nodes': {item['nodeId']: {} for item in items}}
        generation = runtime.start(game, 0, 'unused', items, lambda kind: True)
        depths = []

        def immediate(*args):
            frame = sys._getframe()
            depth = 0
            while frame is not None:
                depth += 1
                frame = frame.f_back
            depths.append(depth)
            future = Future()
            future.set_exception(RuntimeError('model unavailable'))
            return future

        with patch.dict(service.STATE, {'game': game}), \
             patch.object(service, 'AUTO_ANALYSIS_RUNTIME', runtime), \
             patch.object(service._BG_EXECUTOR, 'submit', side_effect=immediate) as submit, \
             patch.object(service, '_auto_analysis_kind_enabled', return_value=True), \
             patch.object(service, '_extend_auto_analysis_plan', return_value=False), \
             patch.object(service, '_emit_auto_analysis_progress'), \
             patch.object(service, 'emit'):
            service._schedule_next_auto_analysis_item(generation)
        self.assertEqual(submit.call_count, len(items))
        self.assertLessEqual(max(depths) - min(depths), 2)
        self.assertEqual(runtime.status['status'], 'completed')
        self.assertEqual(runtime.status['failed'], len(items))
        self.assertIsNone(runtime.future)
        self.assertEqual(runtime.scheduling_generations, set())
        self.assertEqual(runtime.schedule_requested, set())

    def test_dispatch_error_releases_scheduling_guard(self):
        runtime = AutoAnalysisRuntime()
        with patch.object(service, 'AUTO_ANALYSIS_RUNTIME', runtime), \
             patch.object(service, '_dispatch_next_auto_analysis_item', side_effect=RuntimeError('failed')):
            with self.assertRaisesRegex(RuntimeError, 'failed'):
                service._schedule_next_auto_analysis_item(1)
        self.assertEqual(runtime.scheduling_generations, set())
        self.assertEqual(runtime.schedule_requested, set())

    def test_rejected_submissions_finish_without_recursion_or_stuck_activity(self):
        runtime = AutoAnalysisRuntime()
        items = [{'kind': 'decision', 'nodeId': str(index), 'cacheKey': 'test', 'cached': False}
                 for index in range(1200)]
        game = {'gameId': 'test', 'nodes': {item['nodeId']: {} for item in items}}
        generation = runtime.start(game, 0, 'unused', items, lambda kind: True)
        with patch.dict(service.STATE, {'game': game}), \
             patch.object(service, 'AUTO_ANALYSIS_RUNTIME', runtime), \
             patch.object(service._BG_EXECUTOR, 'submit', side_effect=RuntimeError('executor closed')) as submit, \
             patch.object(service, '_auto_analysis_kind_enabled', return_value=True), \
             patch.object(service, '_extend_auto_analysis_plan', return_value=False), \
             patch.object(service, '_emit_auto_analysis_progress'), \
             patch.object(service, 'emit'):
            service._schedule_next_auto_analysis_item(generation)
        self.assertEqual(submit.call_count, len(items))
        self.assertEqual(runtime.status['status'], 'completed')
        self.assertEqual(runtime.status['failed'], len(items))
        self.assertEqual(runtime.status['completed'], len(items))
        self.assertIsNone(runtime.status['currentNodeId'])
        self.assertIsNone(runtime.future)

    def test_cancellation_during_failed_submission_does_not_continue(self):
        runtime = AutoAnalysisRuntime()
        item = {'kind': 'decision', 'nodeId': 'one', 'cacheKey': 'test', 'cached': False}
        game = {'gameId': 'test', 'nodes': {'one': {}}}
        generation = runtime.start(game, 0, 'unused', [item], lambda kind: True)

        def reject(*args):
            runtime.cancel('canceled')
            raise RuntimeError('executor closed')

        with patch.dict(service.STATE, {'game': game}), \
             patch.object(service, 'AUTO_ANALYSIS_RUNTIME', runtime), \
             patch.object(service._BG_EXECUTOR, 'submit', side_effect=reject), \
             patch.object(service, '_auto_analysis_kind_enabled', return_value=True), \
             patch.object(service, '_emit_auto_analysis_progress'):
            service._schedule_next_auto_analysis_item(generation)
        self.assertEqual(runtime.status['status'], 'canceled')
        self.assertEqual(runtime.status['completed'], 0)
        self.assertIsNone(runtime.context)


if __name__ == '__main__':
    unittest.main()
