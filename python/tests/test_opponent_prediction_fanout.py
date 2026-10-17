import unittest
from types import SimpleNamespace

from rms_backend.opponent_prediction_coordinator import OpponentPredictionCoordinator


class PredictionFanoutTests(unittest.TestCase):
    def coordinator(self, count=2, reject=None, fail=None):
        requests = []
        def send(index, **kwargs):
            if index == fail:
                raise RuntimeError('dispatch failure')
            requests.append((index, kwargs))
            return index != reject
        coordinator = object.__new__(OpponentPredictionCoordinator)
        coordinator._active = [SimpleNamespace(accepts_requests=lambda: True,
            request_predict=lambda *args, index=index, **kw: send(index, **kw),
            request_background_predict=lambda *args, index=index, **kw: send(index, **kw)) for index in range(count)]
        return coordinator, requests

    def test_one_discard_aborts_partial_collection_and_ignores_all_late_callbacks(self):
        coordinator, requests = self.coordinator()
        delivered, discarded = [], []
        coordinator.request_predict(on_complete=delivered.append, on_discard=lambda: discarded.append(True))
        requests[0][1]['on_complete']({'status': 'ready', 'outputs': {'one': 1}})
        requests[1][1]['on_discard']()
        requests[0][1]['on_discard']()
        requests[1][1]['on_complete']({'status': 'ready', 'outputs': {'two': 2}})
        self.assertEqual(discarded, [True])
        self.assertEqual(delivered, [])
        coordinator.request_predict(on_complete=delivered.append, on_discard=lambda: discarded.append(True))
        requests[2][1]['on_complete']({'status': 'ready', 'outputs': {'one': 1}})
        requests[3][1]['on_complete']({'status': 'ready', 'outputs': {'two': 2}})
        self.assertEqual(delivered[0]['outputs'], {'one': 1, 'two': 2})
        requests[2][1]['on_discard']()
        requests[3][1]['on_discard']()
        self.assertEqual(discarded, [True], 'already delivered aggregate belongs to its consumer')

    def test_empty_rejected_and_throwing_fanout_reclaim_once_without_fake_predictions(self):
        for options in ({'count': 0}, {'reject': 0}, {'reject': 1}, {'fail': 0}, {'fail': 1}):
            for background in (False, True):
                if not background and 'reject' in options:
                    continue  # Foreground rejection is signalled by the child discard hook.
                with self.subTest(options=options, background=background):
                    coordinator, requests = self.coordinator(**options)
                    delivered, discarded = [], []
                    method = coordinator.request_background_predict if background else coordinator.request_predict
                    if 'fail' in options:
                        with self.assertRaisesRegex(RuntimeError, 'dispatch failure'):
                            method(on_complete=delivered.append, on_discard=lambda: discarded.append(True))
                    else:
                        self.assertFalse(method(on_complete=delivered.append, on_discard=lambda: discarded.append(True)))
                    for _, hooks in requests:
                        hooks['on_discard']()
                        hooks['on_complete']({'status': 'ready'})
                    self.assertEqual(discarded, [True])
                    self.assertEqual(delivered, [])

    def test_single_engine_preserves_complete_payload_and_consumer_failure_discards(self):
        coordinator, requests = self.coordinator(count=1)
        delivered, discarded = [], []
        coordinator.request_predict(on_complete=delivered.append, on_discard=lambda: discarded.append(True))
        payload = {'status': 'ready', 'custom_metadata': {'physical': True}}
        requests[0][1]['on_complete'](payload)
        requests[0][1]['on_discard']()
        self.assertEqual(delivered, [payload])
        self.assertEqual(discarded, [])
        def broken(_):
            raise ValueError('consumer failed')
        coordinator.request_predict(on_complete=broken, on_discard=lambda: discarded.append(True))
        with self.assertRaisesRegex(ValueError, 'consumer failed'):
            requests[1][1]['on_complete']({})
        requests[1][1]['on_discard']()
        self.assertEqual(discarded, [True])
