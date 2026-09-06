import unittest
from unittest.mock import Mock, patch

from opponent_prediction_gateway import OpponentPredictionGateway


class SupersededPredictionTests(unittest.TestCase):
    def test_late_success_after_unload_does_not_restore_model_readiness(self):
        with patch('opponent_prediction_gateway.threading.Thread.start'):
            gateway = OpponentPredictionGateway()
        context = {'nodeId': 'old'}
        callback = Mock()
        gateway._unloaded = False
        gateway._model_ready = True
        gateway._latest_context = context
        gateway._pending = {'snapshot': None, 'controlled_seat': 0, 'context': context,
                            'mjai_events': [], 'include_ground_truth': False,
                            'on_complete': callback}
        gateway._pending_event.set()

        def finish_after_unload(*args, **kwargs):
            gateway.unload()
            gateway._running = False
            return {'outputs': []}

        with patch.object(gateway, '_is_initializing', return_value=False), \
             patch.object(gateway._process_client, 'shutdown'), \
             patch.object(gateway._process_client, 'request', side_effect=finish_after_unload), \
             patch.object(gateway, '_validate_protocol_prediction', return_value=[]), \
             patch.object(gateway, '_protocol_result_to_host', return_value={'status': 'ready'}):
            gateway._run()
        self.assertFalse(gateway._model_ready)
        self.assertTrue(gateway._unloaded)
        callback.assert_not_called()

    def test_old_failure_does_not_replace_new_node_status_or_call_old_callback(self):
        # Run a single worker iteration synchronously; no engine or worker thread starts.
        with patch('opponent_prediction_gateway.threading.Thread.start'):
            gateway = OpponentPredictionGateway()
        old_callback = Mock()
        old = {'nodeId': 'old'}
        new = {'nodeId': 'new'}
        gateway._latest_context = old
        gateway._pending = {'snapshot': None, 'controlled_seat': 0, 'context': old,
                            'mjai_events': [], 'include_ground_truth': False,
                            'on_complete': old_callback}
        gateway._pending_event.set()
        expected = {'context': new, 'status': 'loading'}

        def fail_after_switch(*args, **kwargs):
            gateway.set_latest_context(new)
            gateway._latest = expected.copy()
            gateway._running = False
            raise RuntimeError('old request failed')

        with patch.object(gateway, '_is_initializing', return_value=False), \
             patch.object(gateway._process_client, 'request', side_effect=fail_after_switch), \
             patch.object(gateway, '_set_activity') as activity:
            gateway._run()
        self.assertEqual(gateway.get_latest(), expected)
        old_callback.assert_not_called()
        self.assertFalse(any(call.args[0] == 'error' for call in activity.call_args_list))
        self.assertIsNone(gateway._active_context)

    def test_current_request_failure_is_still_reported(self):
        with patch('opponent_prediction_gateway.threading.Thread.start'):
            gateway = OpponentPredictionGateway()
        context = {'nodeId': 'current'}
        callback = Mock()
        gateway._latest_context = context
        gateway._pending = {'snapshot': None, 'controlled_seat': 0, 'context': context,
                            'mjai_events': [], 'include_ground_truth': False,
                            'on_complete': callback}
        gateway._pending_event.set()

        def fail(*args, **kwargs):
            gateway._running = False
            raise RuntimeError('current request failed')

        with patch.object(gateway, '_is_initializing', return_value=False), \
             patch.object(gateway._process_client, 'request', side_effect=fail), \
             patch.object(gateway, '_set_activity') as activity, \
             patch('traceback.print_exc'), patch('builtins.print'):
            gateway._run()
        callback.assert_called_once()
        self.assertEqual(gateway.get_latest()['context'], context)
        self.assertIn('current request failed', gateway.get_latest()['status'])
        self.assertTrue(any(call.args[0] == 'error' for call in activity.call_args_list))


if __name__ == '__main__':
    unittest.main()
