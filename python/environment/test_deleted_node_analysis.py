import copy
import unittest
from concurrent.futures import Future
from unittest.mock import patch

import service


class DeletedNodeAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.saved = dict(service.STATE)
        self.game = service.create_empty_game(123456)
        parent_id = self.game['currentNodeId']
        self.node = copy.deepcopy(self.game['nodes'][parent_id])
        self.node.update(id='deleted', parentId=parent_id, children=[], mainChildId=None)
        self.node['snapshot']['phase'] = 'discard'
        self.node['analysisCache'] = {}
        self.game['nodes']['deleted'] = self.node
        self.game['nodes'][parent_id]['children'].append('deleted')
        self.game['currentNodeId'] = 'deleted'
        service.STATE.update(game=self.game, gameLoaded=True, mode='research',
                             decisionRecommendationsEnabled=True)
        self.addCleanup(service.STATE.update, self.saved)
        self.addCleanup(service.STATE.clear)
        for name in ('cancel_play_prefetch', 'cancel_auto_analysis', 'request_opponent_analysis'):
            mock = patch.object(service.RECORD_COMMANDS.dependencies, name)
            mock.start()
            self.addCleanup(mock.stop)

    def test_running_decision_result_is_discarded_after_node_deletion(self):
        future = Future()
        future.set_running_or_notify_cancel()
        with patch.object(service.DECISION_ANALYSIS, '_tasks', {}), \
             patch.object(service.DECISION_ANALYSIS, '_completed', set()), \
             patch.object(service.DECISION_ANALYSIS, 'cache_key', return_value='test-key'), \
             patch.object(service, 'play_prefetch_owns_decision', return_value=False), \
             patch.object(service.DECISION_ANALYSIS.dependencies, 'auto_analysis_owns', return_value=False), \
             patch.object(service.ENGINE_MANAGEMENT, 'action_weight_path', return_value=''), \
             patch.object(service.DECISION_ANALYSIS.dependencies, 'build_mjai_stream_bundle', return_value={}), \
             patch.object(service.DECISION_ANALYSIS.dependencies, 'build_legal_actions', return_value=[]), \
             patch.object(service.DECISION_ANALYSIS.executor, 'submit', return_value=future), \
             patch.object(service.DECISION_ANALYSIS, 'store') as store, \
             patch.object(service.DECISION_ANALYSIS.dependencies, 'emit') as emit:
            service.DECISION_ANALYSIS.submit_background(self.node, self.node['snapshot'])
            self.assertEqual(len(service.DECISION_ANALYSIS._tasks), 1)
            service.RECORD_COMMANDS.delete('deleted')
            self.assertFalse(future.cancelled())
            self.assertFalse(service.DECISION_ANALYSIS._tasks)
            emit.reset_mock()
            future.set_result({'analysis': {'value': 1}})
            store.assert_not_called()
            emit.assert_not_called()
            self.assertFalse(service.DECISION_ANALYSIS._completed)
        self.assertNotIn('deleted', self.game['nodes'])
        self.assertEqual(self.node['analysisCache'], {})

    def test_late_opponent_result_cannot_recreate_deleted_node(self):
        context = {'cacheEpoch': service.ENGINE_MANAGEMENT.opponent_cache_epoch,
                   'gameId': self.game['gameId'], 'nodeId': 'deleted',
                   'seat': 0, 'cacheKey': 'test-key'}
        service.RECORD_COMMANDS.delete('deleted')
        with patch.object(service.opponent_analysis_session, 'compact_opponent_analysis', return_value={}), \
             patch.object(service.OPPONENT_ANALYSIS, 'current_context', return_value=None), \
             patch.object(service, 'emit') as emit:
            result = service.OPPONENT_ANALYSIS.cache_result(
                {'context': context, 'status': 'ready'}, require_current=False)
            self.assertFalse(result)
            emit.assert_not_called()
        self.assertNotIn('deleted', self.game['nodes'])


if __name__ == '__main__':
    unittest.main()
