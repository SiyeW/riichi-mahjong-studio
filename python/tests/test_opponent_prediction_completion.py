import unittest
from threading import Barrier, Thread

from rms_backend.opponent_prediction_completion import PredictionCompletion


class PredictionCompletionTests(unittest.TestCase):
    def test_delivery_transfers_ownership_and_cancellation_cannot_reclaim_it(self):
        delivered, discarded = [], []
        completion = PredictionCompletion(delivered.append, lambda: discarded.append(True))
        self.assertTrue(completion.complete({'value': 1}))
        self.assertFalse(completion.discard())
        self.assertFalse(completion.complete({'value': 2}))
        self.assertEqual(delivered, [{'value': 1}])
        self.assertEqual(discarded, [])

    def test_discard_is_once_and_blocks_late_delivery(self):
        delivered, discarded = [], []
        completion = PredictionCompletion(delivered.append, lambda: discarded.append(True))
        self.assertTrue(completion.discard())
        self.assertFalse(completion.discard())
        self.assertFalse(completion.complete({}))
        self.assertEqual(delivered, [])
        self.assertEqual(discarded, [True])

    def test_failed_or_missing_consumer_returns_its_resources(self):
        for fail in (False, True):
            discarded = []
            def broken(_):
                raise ValueError('consumer failure')
            completion = PredictionCompletion(broken if fail else None, lambda: discarded.append(True))
            if fail:
                with self.assertRaisesRegex(ValueError, 'consumer failure'):
                    completion.complete({})
            else:
                completion.complete({})
            completion.discard()
            self.assertEqual(discarded, [True])

    def test_callbacks_are_reentrant_and_racing_outcomes_are_exclusive(self):
        for _ in range(30):
            outcomes, start = [], Barrier(3)
            completion = PredictionCompletion(lambda value: outcomes.append('delivered'), lambda: outcomes.append('discarded'))
            threads = [Thread(target=lambda: (start.wait(), completion.complete({}))),
                       Thread(target=lambda: (start.wait(), completion.discard()))]
            for thread in threads:
                thread.start()
            start.wait()
            for thread in threads:
                thread.join(2)
                self.assertFalse(thread.is_alive())
            self.assertEqual(len(outcomes), 1)
        completion = PredictionCompletion(lambda _: completion.discard())
        self.assertTrue(completion.complete({}))
