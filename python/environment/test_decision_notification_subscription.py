import unittest
from unittest.mock import patch

from action_recommendation_gateway import ActionRecommendationGateway
from engine_runtime import EngineProfileRuntime


class DecisionNotificationSubscriptionTests(unittest.TestCase):
    def runtime(self, name):
        with patch('engine_runtime.EngineProcessClient'):
            return EngineProfileRuntime(
                profile_id=name, engine_id=name, engine_version='1', command=['unused'],
                cwd=None, enabled_outputs=[{'id': 'action-recommendation'}],
                weights=[], device_preference='cpu', options={},
            )

    def configure(self, gateway, runtime):
        gateway.configure_profile(
            profile_id=runtime.profile_id, engine_id=runtime.profile_id,
            model_id='', model_format='', engine_command=['unused'], engine_client=runtime,
        )
        gateway.prepare_reload()

    def test_reconfiguration_detaches_old_listener_and_rejects_copied_callback(self):
        gateway = ActionRecommendationGateway()
        old, new = self.runtime('old'), self.runtime('new')
        self.configure(gateway, old)
        copied_callback = old._listeners[0]
        self.configure(gateway, new)
        self.assertEqual(old._listeners, [])
        copied_callback('engine.status', {'state': 'error', 'message': 'stale'})
        self.assertIsNone(gateway.activity_error())
        new._notify('engine.status', {'state': 'loading'})
        self.assertEqual(gateway.activity_state(), 'loading')
        self.assertEqual(len(new._listeners), 1)

    def test_reload_between_notification_dispatch_and_state_update_is_ignored(self):
        gateway = ActionRecommendationGateway()
        runtime = self.runtime('current')
        self.configure(gateway, runtime)
        original = gateway._on_engine_notification

        def delayed(method, params, **kwargs):
            gateway.prepare_reload()
            gateway._set_activity(2, 'loading')
            original(method, params, **kwargs)

        with patch.object(gateway, '_on_engine_notification', side_effect=delayed):
            runtime._notify('engine.status', {'state': 'error', 'message': 'old request'})
        self.assertEqual(gateway.activity_state(), 'loading')
        self.assertEqual(gateway.active_seat(), 2)
        self.assertIsNone(gateway.activity_error())

    def test_shutdown_releases_subscription(self):
        gateway = ActionRecommendationGateway()
        runtime = self.runtime('current')
        self.configure(gateway, runtime)
        callback = runtime._listeners[0]
        gateway.shutdown()
        self.assertEqual(runtime._listeners, [])
        gateway._unloaded = False
        callback('engine.status', {'state': 'error', 'message': 'stale'})
        self.assertIsNone(gateway.activity_error())


if __name__ == '__main__':
    unittest.main()
