import unittest
from types import SimpleNamespace
from unittest.mock import patch

from opponent_prediction_gateway import OpponentPredictionGateway


class InitializationLifecycleTests(unittest.TestCase):
    def test_old_initialization_cleanup_preserves_new_loading_state(self):
        with patch('opponent_prediction_requests.threading.Thread.start'):
            gateway = OpponentPredictionGateway()
        gateway._activity.reset(unloaded=False)

        def initialize(*args, **kwargs):
            gateway.prepare_reload()
            gateway._set_activity('loading')
            raise RuntimeError('old initialization interrupted')

        with patch.object(gateway._process_client, 'restart'), \
             patch('opponent_prediction_gateway.initialize_engine_client', side_effect=initialize):
            self.assertFalse(gateway.prewarm())
        self.assertEqual(gateway.activity_state(), 'loading')
        self.assertIsNone(gateway.activity_error())

    def test_stale_activity_update_does_not_latch_error_or_notify(self):
        with patch('opponent_prediction_requests.threading.Thread.start'):
            gateway = OpponentPredictionGateway()
        gateway._activity.reset(unloaded=False)
        notifications = []
        gateway.set_activity_callback(lambda *args: notifications.append(args))
        generation = gateway._activity.generation
        gateway._invalidate_initialization()
        gateway._set_activity('error', 'stale', expected_generation=generation)
        self.assertFalse(gateway._activity.error_latched())
        self.assertEqual(notifications, [])
        gateway._set_activity(
            'loading',
            expected_generation=gateway._activity.generation,
        )
        self.assertEqual(notifications, [('loading', None)])

    def test_late_initialization_cannot_publish_after_unload_or_reload(self):
        for transition in ('unload', 'prepare_reload'):
            for fails in (False, True):
                with self.subTest(transition=transition, fails=fails):
                    with patch('opponent_prediction_requests.threading.Thread.start'):
                        gateway = OpponentPredictionGateway()
                    gateway._activity.reset(unloaded=False)
                    outputs = gateway._requested_output_contracts()
                    initialization = SimpleNamespace(
                        references={item['id']: {'id': item['id']} for item in outputs},
                        contracts={item['id']: {} for item in outputs},
                        outputs={item['id']: {} for item in outputs},
                        protocol_minor=2, result={}, device='old-device')

                    def initialize(*args, **kwargs):
                        getattr(gateway, transition)()
                        if fails:
                            raise RuntimeError('old initialization failed')
                        return initialization

                    with patch.object(gateway._process_client, 'shutdown'), \
                         patch.object(gateway._process_client, 'restart'), \
                         patch('opponent_prediction_gateway.initialize_engine_client', side_effect=initialize):
                        self.assertFalse(gateway.prewarm())
                    self.assertFalse(gateway._model_ready)
                    self.assertNotEqual(gateway._identity.actual_device, 'old-device')
                    self.assertNotEqual(gateway.get_latest()['status'], 'loaded')
                    self.assertFalse(gateway._activity.error_latched())

    def test_current_initialization_can_still_publish(self):
        with patch('opponent_prediction_requests.threading.Thread.start'):
            gateway = OpponentPredictionGateway()
        gateway._activity.reset(unloaded=False)
        outputs = gateway._requested_output_contracts()
        initialization = SimpleNamespace(
            references={item['id']: {'id': item['id']} for item in outputs},
            contracts={item['id']: {} for item in outputs},
            outputs={item['id']: {} for item in outputs},
            protocol_minor=2, result={}, device='cpu')
        with patch('opponent_prediction_gateway.initialize_engine_client', return_value=initialization):
            self.assertTrue(gateway.prewarm())
        self.assertTrue(gateway._model_ready)
        self.assertEqual(gateway._identity.actual_device, 'cpu')

    def test_fingerprint_calculation_does_not_hold_request_lock(self):
        with patch('opponent_prediction_requests.threading.Thread.start'):
            gateway = OpponentPredictionGateway()
        gateway._activity.reset(unloaded=False)
        outputs = gateway._requested_output_contracts()
        initialization = SimpleNamespace(
            references={item['id']: {'id': item['id']} for item in outputs},
            contracts={item['id']: {} for item in outputs},
            outputs={item['id']: {} for item in outputs},
            protocol_minor=2, result={}, device='cpu')
        gateway._profile.configured_weights = [
            {'slotId': 'model', 'format': 'test', 'path': 'unused'}
        ]
        acquired = []

        def hash_weight(path):
            available = gateway._requests._lock.acquire(blocking=False)
            acquired.append(available)
            if available:
                gateway._requests._lock.release()
            return 'test-hash'

        with patch('opponent_prediction_gateway.initialize_engine_client', return_value=initialization), \
             patch(
                 'opponent_prediction_profile._weight_sha256',
                 side_effect=hash_weight,
             ):
            self.assertTrue(gateway.prewarm())
        self.assertEqual(acquired, [True])

    def test_reload_during_fingerprint_calculation_discards_initialization(self):
        with patch('opponent_prediction_requests.threading.Thread.start'):
            gateway = OpponentPredictionGateway()
        gateway._activity.reset(unloaded=False)
        outputs = gateway._requested_output_contracts()
        initialization = SimpleNamespace(
            contracts={item['id']: {} for item in outputs},
            outputs={item['id']: {} for item in outputs},
            protocol_minor=2, result={}, device='old-device')

        def fingerprint(*args):
            gateway.prepare_reload()
            return 'old-fingerprint'

        with patch('opponent_prediction_gateway.initialize_engine_client', return_value=initialization), \
             patch.object(gateway._process_client, 'restart'), \
             patch.object(
                 gateway._identity,
                 'calculate_cache_identity',
                 side_effect=fingerprint,
             ):
            self.assertFalse(gateway.prewarm())
        self.assertFalse(gateway._model_ready)
        self.assertNotEqual(
            gateway._identity.engine_fingerprint,
            'old-fingerprint',
        )


if __name__ == '__main__':
    unittest.main()
