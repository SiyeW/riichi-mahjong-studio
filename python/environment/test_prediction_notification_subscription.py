import unittest
from unittest.mock import patch

from engine_runtime import EngineProfileRuntime
from opponent_prediction_gateway import OpponentPredictionGateway


class PredictionNotificationSubscriptionTests(unittest.TestCase):
    def gateway(self):
        with patch('opponent_prediction_gateway.threading.Thread.start'):
            return OpponentPredictionGateway()

    def runtime(self, name):
        with patch('engine_runtime.EngineProcessClient'):
            return EngineProfileRuntime(
                profile_id=name, engine_id=name, engine_version='1', command=['unused'],
                cwd=None, enabled_outputs=[{'id': 'opponent-shanten'}], weights=[],
                device_preference='cpu', options={},
            )

    def configure(self, gateway, runtime):
        gateway.configure_profile(
            profile_id=runtime.profile_id, engine_id=runtime.profile_id, engine_version='1',
            model_id='', model_format='', model_path='', engine_command=['unused'],
            engine_client=runtime, enabled_outputs=['opponent-shanten'],
        )
        gateway.prepare_reload()

    def test_retired_subscription_cannot_change_new_state(self):
        gateway = self.gateway()
        old, new = self.runtime('old'), self.runtime('new')
        self.configure(gateway, old)
        copied = old._listeners[0]
        self.configure(gateway, new)
        self.assertEqual(old._listeners, [])
        copied('engine.status', {'state': 'error', 'message': 'stale'})
        self.assertIsNone(gateway.activity_error())
        new._notify('engine.status', {'state': 'loading'})
        self.assertEqual(gateway.activity_state(), 'loading')

    def test_reload_during_callback_preserves_new_state(self):
        gateway = self.gateway()
        runtime = self.runtime('current')
        self.configure(gateway, runtime)
        original = gateway._on_engine_notification

        def delayed(method, params, **kwargs):
            gateway.prepare_reload()
            gateway._set_activity('loading')
            original(method, params, **kwargs)

        with patch.object(gateway, '_on_engine_notification', side_effect=delayed):
            runtime._notify('task.status', {'state': 'error', 'message': 'stale'})
        self.assertEqual(gateway.activity_state(), 'loading')
        self.assertIsNone(gateway.activity_error())

    def test_shutdown_detaches_and_invalidates_initialization(self):
        gateway = self.gateway()
        runtime = self.runtime('current')
        self.configure(gateway, runtime)
        copied = runtime._listeners[0]
        generation = gateway._lifecycle_generation
        gateway.shutdown()
        self.assertEqual(runtime._listeners, [])
        self.assertGreater(gateway._lifecycle_generation, generation)
        copied('engine.status', {'state': 'error', 'message': 'stale'})
        self.assertIsNone(gateway.activity_error())
        self.assertFalse(gateway._running)


if __name__ == '__main__':
    unittest.main()
