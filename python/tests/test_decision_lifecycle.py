import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock, patch

from rms_backend.action_recommendation_gateway import ActionRecommendationGateway


def initialized_result():
    key = 'action-recommendation'
    return SimpleNamespace(
        result={'effectiveOptions': {'new': True}},
        contracts={key: {}}, outputs={key: {}}, references={key: {'id': key}},
        protocol_minor=99, device='new-device',
    )


class DecisionLifecycleTests(unittest.TestCase):
    def gateway(self):
        gateway = ActionRecommendationGateway()
        gateway._client = Mock()
        gateway._unloaded = False
        gateway._external_engine = True
        return gateway

    def test_initialization_cannot_publish_after_lifecycle_change(self):
        for operation in ('unload', 'prepare_reload', 'set_force_device', 'shutdown'):
            with self.subTest(operation=operation):
                gateway = self.gateway()

                def initialize(*args, **kwargs):
                    if operation == 'set_force_device':
                        gateway.set_force_device('cpu')
                    else:
                        getattr(gateway, operation)()
                    return initialized_result()

                with patch('rms_backend.action_recommendation_gateway.initialize_engine_client', side_effect=initialize):
                    self.assertFalse(gateway.prewarm(0, 'unused'))
                self.assertEqual(gateway._ready_models, set())
                self.assertEqual(gateway._last_fingerprint, '')
                self.assertEqual(gateway._protocol_minor, 2)
                self.assertEqual(gateway._actual_device, '')
                self.assertFalse(gateway._error_latched)

    def test_late_failure_cannot_replace_new_activity(self):
        gateway = self.gateway()

        def initialize(*args, **kwargs):
            gateway.prepare_reload()
            gateway._set_activity(1, 'loading')
            raise RuntimeError('old worker failed')

        with patch('rms_backend.action_recommendation_gateway.initialize_engine_client', side_effect=initialize):
            self.assertFalse(gateway.prewarm(0, 'unused'))
        self.assertEqual(gateway.activity_state(), 'loading')
        self.assertEqual(gateway.active_seat(), 1)
        self.assertIsNone(gateway.activity_error())

    def test_successful_initialization_publishes_matching_fingerprint(self):
        gateway = self.gateway()
        with patch('rms_backend.action_recommendation_gateway.initialize_engine_client', return_value=initialized_result()):
            self.assertTrue(gateway.prewarm(0, 'unused'))
        fingerprint = gateway._last_fingerprint
        self.assertTrue(fingerprint.startswith('sha256:'))
        gateway._last_fingerprint = ''
        self.assertEqual(gateway.cache_identity('unused'), fingerprint)
        self.assertEqual(gateway._protocol_minor, 99)
        self.assertEqual(gateway._actual_device, 'new-device')

    def test_superseded_waiter_does_not_initialize(self):
        gateway = self.gateway()
        generation = gateway._lifecycle_generation
        gateway.prepare_reload()
        with patch.object(gateway, '_initialize') as initialize:
            with self.assertRaisesRegex(RuntimeError, 'superseded'):
                gateway._ensure_initialized('unused', generation)
            initialize.assert_not_called()

    def test_weight_hash_does_not_block_unload_or_publish_after_it(self):
        gateway = self.gateway()

        def fingerprint(*args, **kwargs):
            acquired = gateway._lock.acquire(blocking=False)
            self.assertTrue(acquired)
            if acquired:
                gateway._lock.release()
            gateway.unload()
            return 'stale'

        with patch('rms_backend.action_recommendation_gateway.initialize_engine_client', return_value=initialized_result()), \
             patch.object(gateway, '_calculate_cache_identity', side_effect=fingerprint):
            self.assertFalse(gateway.prewarm(0, 'unused'))
        self.assertEqual(gateway._last_fingerprint, '')
        self.assertFalse(gateway._ready_models)

    def test_concurrent_prewarm_initializes_once(self):
        gateway = self.gateway()
        entered = threading.Event()
        release = threading.Event()

        def initialize(*args, **kwargs):
            entered.set()
            if not release.wait(3):
                raise RuntimeError('test synchronization timed out')
            return initialized_result()

        with patch('rms_backend.action_recommendation_gateway.initialize_engine_client', side_effect=initialize) as initialize_mock:
            with ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(gateway.prewarm, 0, 'unused')
                try:
                    self.assertTrue(entered.wait(3))
                    second = executor.submit(gateway.prewarm, 1, 'unused')
                finally:
                    release.set()
                self.assertTrue(first.result(timeout=3))
                self.assertTrue(second.result(timeout=3))
            initialize_mock.assert_called_once()

    def test_analysis_discards_response_after_reload(self):
        for failure in (False, True):
            with self.subTest(failure=failure):
                gateway = self.gateway()

                def request(*args, **kwargs):
                    gateway.prepare_reload()
                    gateway._set_activity(2, 'loading')
                    if failure:
                        raise RuntimeError('old inference failed')
                    return {'outputs': [{'id': 'action-recommendation',
                                         'data': {'bestCandidateId': 'a'}}]}

                gateway._client.request.side_effect = request
                with patch('rms_backend.action_recommendation_gateway.initialize_engine_client', return_value=initialized_result()):
                    with self.assertRaises(RuntimeError):
                        gateway.analyze_candidates(0, 'unused', 'test', [], [{'id': 'a', 'type': 'none'}])
                self.assertEqual(gateway.activity_state(), 'loading')
                self.assertEqual(gateway.active_seat(), 2)
                self.assertIsNone(gateway.activity_error())
                self.assertFalse(gateway._ready_models)
                self.assertEqual(gateway.average_response_ms(), 0)


if __name__ == '__main__':
    unittest.main()
