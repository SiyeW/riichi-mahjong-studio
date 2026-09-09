import unittest
from unittest.mock import Mock

from rms_backend.opponent_prediction_coordinator import OpponentPredictionCoordinator


class PredictionCoordinationTests(unittest.TestCase):
    def test_rejected_request_does_not_merge_previous_node_results(self):
        coordinator = OpponentPredictionCoordinator()
        rejected, accepted = Mock(), Mock()
        coordinator._active = [rejected, accepted]
        rejected.request_background_predict.return_value = False
        rejected.get_latest.return_value = {
            'status': 'ready', 'context': {'nodeId': 'old'}, 'outputs': {'old': 1},
        }
        accepted.request_background_predict.return_value = True
        callback = Mock()
        self.assertTrue(coordinator.request_background_predict({}, 0, context={'nodeId': 'new'}, on_complete=callback))
        callback.assert_not_called()
        child_callback = accepted.request_background_predict.call_args.kwargs['on_complete']
        child_callback({'status': 'ready', 'context': {'nodeId': 'new'}, 'outputs': {'new': 2}})
        callback.assert_called_once()
        result = callback.call_args.args[0]
        self.assertEqual(result['status'], 'request_rejected')
        self.assertEqual(result['context'], {'nodeId': 'new'})
        self.assertEqual(result['outputs'], {'new': 2})
        rejected.get_latest.assert_not_called()

    def test_callbacks_are_counted_once_per_engine_and_merged_in_engine_order(self):
        coordinator = OpponentPredictionCoordinator()
        callback = Mock()
        first, second = coordinator._combined_callback([Mock(), Mock()], callback)
        second({'status': 'ready', 'outputs': {'shared': 2}})
        second({'status': 'ready', 'outputs': {'shared': 99}})
        callback.assert_not_called()
        first({'status': 'ready', 'outputs': {'shared': 1}})
        callback.assert_called_once()
        self.assertEqual(callback.call_args.args[0]['outputs']['shared'], 2)
        first({'status': 'ready'})
        callback.assert_called_once()


if __name__ == '__main__':
    unittest.main()
