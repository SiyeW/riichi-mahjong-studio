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
