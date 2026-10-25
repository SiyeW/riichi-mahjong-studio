import unittest
from unittest import mock

from rms_backend.opponent_prediction_activity import OpponentPredictionActivity
from rms_backend.opponent_prediction_requests import OpponentPredictionRequests


class OpponentPredictionRequestsTests(unittest.TestCase):
    def setUp(self):
        self.activity = OpponentPredictionActivity()
        self.activity.reset(unloaded=False)
        thread_start = mock.patch(
            "rms_backend.opponent_prediction_requests.threading.Thread.start"
        )
        thread_start.start()
        self.addCleanup(thread_start.stop)
        self.requests = OpponentPredictionRequests(
            activity=self.activity,
            supported_input_modes=lambda: ("public",),
            is_initializing=lambda: False,
            prewarm=lambda: True,
            execute=lambda _request, _initializing: ({"status": "ready"}, 1.0),
            activity_error=self.activity.error,
            format_error=lambda prefix, error: f"{prefix}: {error}",
        )

    def test_foreground_request_replaces_the_pending_context(self):
        snapshot = {"value": [1]}

        self.requests.request_foreground(
            snapshot,
            0,
            **self._request_options(context={"nodeId": "n1"}),
        )
        snapshot["value"].append(2)

        self.assertTrue(self.requests.has_request({"nodeId": "n1"}))
        self.assertEqual(
            self.requests.get_latest()["context"],
            {"nodeId": "n1"},
        )
        self.assertEqual(self.requests._pending["snapshot"], {"value": [1]})

    def test_duplicate_background_context_is_rejected(self):
        options = self._request_options(context={"nodeId": "n1"})

        first = self.requests.request_background({}, 0, **options)
        second = self.requests.request_background({}, 0, **options)

        self.assertTrue(first)
        self.assertFalse(second)

    def test_prebuilt_stream_does_not_retain_snapshot(self):
        options = self._request_options(
            context={"nodeId": "n1"},
            mjai_events=[{"type": "start_game"}],
            include_ground_truth=False,
        )

        self.requests.request_foreground({"large": True}, 0, **options)

        self.assertIsNone(self.requests._pending["snapshot"])

    def test_replacement_and_repeated_cancellation_discard_once_outside_queue_lock(self):
        discarded = []
        def hook(label):
            def discard():
                self.assertTrue(self.requests._lock.acquire(blocking=False), 'consumer cannot run under queue lock')
                self.requests._lock.release()
                discarded.append(label)
            return discard
        for label in ('old', 'new'):
            self.requests.request_foreground({}, 0, **self._request_options(
                context={'nodeId': label}, on_discard=hook(label)))
        self.assertEqual(discarded, ['old'])
        self.requests.cancel_all()
        self.requests.cancel_pending()
        self.requests.shutdown()
        self.assertEqual(discarded, ['old', 'new'])

    def test_background_and_foreground_cancellation_remain_independent(self):
        for background_active in (False, True):
            with self.subTest(background_active=background_active):
                self.requests.cancel_all()
                self.requests._finish_request()
                discarded = []
                def send(background, label):
                    method = self.requests.request_background if background else self.requests.request_foreground
                    return method({}, 0, **self._request_options(context={'nodeId': label},
                        on_discard=lambda: discarded.append(label)))
                send(background_active, 'active')
                active = self.requests._take_next()
                send(not background_active, 'queued')
                (self.requests.cancel_pending if background_active else self.requests.cancel_background)()
                self.assertEqual(discarded, ['queued'])
                self.assertFalse(active['retired'])
                (self.requests.cancel_background if background_active else self.requests.cancel_pending)()
                self.assertEqual(discarded, ['queued', 'active'])
                self.requests._retire(active)
                self.assertEqual(len(discarded), 2)

    def test_duplicate_background_rejection_does_not_discard_original(self):
        discarded = []
        for label in ('original', 'duplicate'):
            accepted = self.requests.request_background({}, 0, **self._request_options(
                context={'nodeId': 'same'}, on_discard=lambda label=label: discarded.append(label)))
            self.assertEqual(accepted, label == 'original')
        self.assertEqual(discarded, ['duplicate'])
        self.requests.cancel_background()
        self.assertEqual(discarded, ['duplicate', 'original'])

    def test_invalid_input_and_failed_snapshot_copy_return_unaccepted_resources(self):
        discarded = []
        with self.assertRaises(ValueError):
            self.requests.request_foreground({}, 0, **self._request_options(
                input_mode='invalid', on_discard=lambda: discarded.append('mode')))
        class BrokenCopy:
            def __deepcopy__(self, memo):
                raise ValueError('snapshot copy failure')
        with self.assertRaisesRegex(ValueError, 'snapshot copy failure'):
            self.requests.request_foreground(BrokenCopy(), 0, **self._request_options(
                on_discard=lambda: discarded.append('copy')))
        self.assertEqual(discarded, ['mode', 'copy'])
        self.assertFalse(self.requests.has_work())

    def test_shutdown_rejects_new_work_and_bad_cleanup_does_not_strand_other_jobs(self):
        discarded = []
        def broken():
            raise ValueError('bad cleanup')
        self.requests.request_background({}, 0, **self._request_options(
            context={'nodeId': 'bad'}, on_discard=broken))
        self.requests.request_background({}, 0, **self._request_options(
            context={'nodeId': 'good'}, on_discard=lambda: discarded.append('good')))
        with mock.patch('builtins.print'):
            self.requests.shutdown()
        self.assertFalse(self.requests.request_background({}, 0, **self._request_options(
            on_discard=lambda: discarded.append('rejected'))))
        self.assertEqual(discarded, ['good', 'rejected'])
        self.assertFalse(self.requests.has_work())

    @staticmethod
    def _request_options(**overrides):
        options = {
            "input_mode": "public",
            "context": None,
            "on_complete": None,
            "mjai_events": None,
            "mjai_prefix_hashes": None,
            "mjai_events_hash": None,
            "target_mjai_events": None,
            "target_mjai_prefix_hashes": None,
            "target_mjai_events_hash": None,
            "include_ground_truth": True,
        }
        options.update(overrides)
        return options


if __name__ == "__main__":
    unittest.main()
