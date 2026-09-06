import unittest
from types import SimpleNamespace
from unittest.mock import patch

from opponent_prediction_gateway import OpponentPredictionGateway


class InitializationLifecycleTests(unittest.TestCase):
    def test_late_initialization_cannot_publish_after_unload_or_reload(self):
        for transition in ('unload', 'prepare_reload'):
            for fails in (False, True):
                with self.subTest(transition=transition, fails=fails):
                    with patch('opponent_prediction_gateway.threading.Thread.start'):
                        gateway = OpponentPredictionGateway()
                    gateway._unloaded = False
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
                    self.assertNotEqual(gateway._actual_device, 'old-device')
                    self.assertNotEqual(gateway.get_latest()['status'], 'loaded')
                    self.assertFalse(gateway._error_latched)

    def test_current_initialization_can_still_publish(self):
        with patch('opponent_prediction_gateway.threading.Thread.start'):
            gateway = OpponentPredictionGateway()
        gateway._unloaded = False
        outputs = gateway._requested_output_contracts()
        initialization = SimpleNamespace(
            references={item['id']: {'id': item['id']} for item in outputs},
            contracts={item['id']: {} for item in outputs},
            outputs={item['id']: {} for item in outputs},
            protocol_minor=2, result={}, device='cpu')
        with patch('opponent_prediction_gateway.initialize_engine_client', return_value=initialization):
            self.assertTrue(gateway.prewarm())
        self.assertTrue(gateway._model_ready)
        self.assertEqual(gateway._actual_device, 'cpu')


if __name__ == '__main__':
    unittest.main()
