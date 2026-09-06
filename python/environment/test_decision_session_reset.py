import unittest
from unittest.mock import Mock

from action_recommendation_gateway import ActionRecommendationGateway


class DecisionSessionResetTests(unittest.TestCase):
    def make_gateway(self):
        gateway = ActionRecommendationGateway()
        gateway._client = Mock()
        gateway._unloaded = False
        gateway._ready_models = {'model'}
        gateway._last_fingerprint = 'old-worker'
        gateway._model_hash_cache = ('model', 1, 2, 'hash')
        return gateway

    def test_failed_reset_invalidates_worker_readiness(self):
        gateway = self.make_gateway()
        gateway._client.request.side_effect = RuntimeError('worker exited')
        gateway.reset_session()
        gateway._client.restart.assert_called_once_with()
        self.assertEqual(gateway._ready_models, set())
        self.assertEqual(gateway._last_fingerprint, '')
        self.assertIsNone(gateway._model_hash_cache)
        self.assertTrue(gateway.accepts_requests())
        self.assertEqual(gateway.activity_state(), 'idle')
        gateway._initialize = Mock(return_value={})
        self.assertTrue(gateway.prewarm(0, 'model'))
        gateway._initialize.assert_called_once()

    def test_successful_reset_preserves_initialized_model(self):
        gateway = self.make_gateway()
        gateway.reset_session()
        gateway._client.restart.assert_not_called()
        self.assertEqual(gateway._ready_models, {'model'})
        self.assertEqual(gateway._last_fingerprint, 'old-worker')

    def test_uninitialized_reset_does_not_start_worker(self):
        gateway = self.make_gateway()
        gateway._ready_models.clear()
        gateway.reset_session()
        gateway._client.request.assert_not_called()
        gateway._client.restart.assert_not_called()


if __name__ == '__main__':
    unittest.main()
