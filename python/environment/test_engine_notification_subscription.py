import unittest
from unittest.mock import patch

from action_recommendation_gateway import ActionRecommendationGateway
from engine_runtime import EngineProfileRuntime
from opponent_prediction_gateway import OpponentPredictionGateway


class EngineNotificationSubscriptionTests(unittest.TestCase):
    KINDS = ('decision', 'prediction')

    def gateway(self, kind):
        if kind == 'decision':
            return ActionRecommendationGateway()
        with patch('opponent_prediction_requests.threading.Thread.start'):
            return OpponentPredictionGateway()

    def runtime(self, kind, name):
        output_id = 'action-recommendation' if kind == 'decision' else 'opponent-shanten'
        with patch('engine_runtime.EngineProcessClient'):
            return EngineProfileRuntime(
                profile_id=name, engine_id=name, engine_version='1', command=['unused'],
                cwd=None, enabled_outputs=[{'id': output_id}], weights=[],
                device_preference='cpu', options={},
            )

    def configure(self, kind, gateway, runtime):
        common = {
            'profile_id': runtime.profile_id,
            'engine_id': runtime.profile_id,
            'model_id': '',
            'model_format': '',
            'engine_command': ['unused'],
            'engine_client': runtime,
        }
        if kind == 'prediction':
            common.update({
                'engine_version': '1',
                'model_path': '',
                'enabled_outputs': ['opponent-shanten'],
            })
        gateway.configure_profile(**common)
        gateway.prepare_reload()

    def set_loading_state(self, kind, gateway):
        if kind == 'decision':
            gateway._set_activity(2, 'loading')
        else:
            gateway._set_activity('loading')

    def test_reconfiguration_detaches_old_listener_and_rejects_copied_callback(self):
        for kind in self.KINDS:
            with self.subTest(kind=kind):
                gateway = self.gateway(kind)
                old, new = self.runtime(kind, 'old'), self.runtime(kind, 'new')
                self.configure(kind, gateway, old)
                copied = old._listeners[0]
                self.configure(kind, gateway, new)
                self.assertEqual(old._listeners, [])
                copied('engine.status', {'state': 'error', 'message': 'stale'})
                self.assertIsNone(gateway.activity_error())
                new._notify('engine.status', {'state': 'loading'})
                self.assertEqual(gateway.activity_state(), 'loading')
                self.assertEqual(len(new._listeners), 1)

    def test_reload_during_callback_preserves_new_state(self):
        for kind in self.KINDS:
            with self.subTest(kind=kind):
                gateway = self.gateway(kind)
                runtime = self.runtime(kind, 'current')
                self.configure(kind, gateway, runtime)
                original = gateway._on_engine_notification

                def delayed(method, params, **kwargs):
                    gateway.prepare_reload()
                    self.set_loading_state(kind, gateway)
                    original(method, params, **kwargs)

                method = 'engine.status' if kind == 'decision' else 'task.status'
                with patch.object(gateway, '_on_engine_notification', side_effect=delayed):
                    runtime._notify(method, {'state': 'error', 'message': 'old request'})
                self.assertEqual(gateway.activity_state(), 'loading')
                self.assertIsNone(gateway.activity_error())
                if kind == 'decision':
                    self.assertEqual(gateway.active_seat(), 2)

    def test_shutdown_detaches_and_rejects_copied_callback(self):
        for kind in self.KINDS:
            with self.subTest(kind=kind):
                gateway = self.gateway(kind)
                runtime = self.runtime(kind, 'current')
                self.configure(kind, gateway, runtime)
                copied = runtime._listeners[0]
                generation = (
                    gateway._lifecycle_generation
                    if kind == 'decision'
                    else gateway._activity.generation
                )
                gateway.shutdown()
                self.assertEqual(runtime._listeners, [])
                current_generation = (
                    gateway._lifecycle_generation
                    if kind == 'decision'
                    else gateway._activity.generation
                )
                self.assertGreater(current_generation, generation)
                if kind == 'decision':
                    gateway._unloaded = False
                copied('engine.status', {'state': 'error', 'message': 'stale'})
                self.assertIsNone(gateway.activity_error())
                if kind == 'prediction':
                    self.assertFalse(gateway._requests._running)


if __name__ == '__main__':
    unittest.main()
