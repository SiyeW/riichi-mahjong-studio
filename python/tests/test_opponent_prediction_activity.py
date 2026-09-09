import unittest
from unittest import mock

from rms_backend.opponent_prediction_activity import OpponentPredictionActivity


class OpponentPredictionActivityTests(unittest.TestCase):
    def setUp(self):
        self.activity = OpponentPredictionActivity()
        self.callback = mock.Mock()
        self.activity.set_callback(self.callback)
        self.activity.reset(unloaded=False)

    def test_stale_generation_cannot_publish_state(self):
        generation = self.activity.generation
        self.activity.invalidate()

        self.activity.set(
            "error",
            "stale",
            expected_generation=generation,
        )

        self.assertEqual(self.activity.state(), "idle")
        self.assertIsNone(self.activity.error())
        self.assertFalse(self.activity.error_latched())
        self.callback.assert_not_called()

    def test_latched_error_rejects_later_non_error_updates(self):
        self.activity.set("error", "failed")
        self.activity.set("running")

        self.assertEqual(self.activity.state(), "error")
        self.assertEqual(self.activity.error(), "failed")
        self.callback.assert_called_once_with("error", "failed")

    def test_unloaded_activity_is_always_idle(self):
        self.activity.reset(unloaded=True)

        self.activity.set("loading")

        self.assertEqual(self.activity.state(), "idle")
        self.assertIsNone(self.activity.error())
        self.callback.assert_not_called()

    def test_response_average_keeps_the_ten_most_recent_samples(self):
        for value in range(12):
            self.activity.record_response_ms(value)

        self.assertEqual(self.activity.last_response_ms(), 11.0)
        self.assertEqual(self.activity.average_response_ms(), 6.5)


if __name__ == "__main__":
    unittest.main()
