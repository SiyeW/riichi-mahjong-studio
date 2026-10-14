import unittest

from rms_backend.records.decoded_cache import DecodedAnalysisCache


class DecodedAnalysisCacheTests(unittest.TestCase):
    def test_full_traversal_reaches_plateau_and_hot_hits_do_no_loading(self):
        cache = DecodedAnalysisCache(1000)
        for index in range(500):
            value = {'index': index}
            cache.put(index, value, 100, reloadable=True)
            self.assertIs(cache.get(index), value)
            self.assertLessEqual(cache.metrics()['residentBytes'], 1000)
        self.assertEqual(cache.metrics()['entries'], 10)
        self.assertEqual(cache.metrics()['evictions'], 490)
        self.assertIsNone(cache.get(0))
        self.assertEqual(cache.get(499), {'index': 499})

    def test_dirty_and_borrowed_entries_survive_budget_reduction_with_truthful_overshoot(self):
        cache = DecodedAnalysisCache(1000)
        cache.put('dirty', {}, 600, reloadable=False)
        cache.put('active', {}, 400, reloadable=True)
        with cache.borrow('active'):
            cache.set_budget(100)
            self.assertEqual(cache.metrics()['residentBytes'], 1000)
            self.assertEqual(cache.metrics()['protectedBytes'], 1000)
            self.assertEqual(cache.metrics()['protectedOvershootBytes'], 900)
            cache.backed('dirty')
            self.assertEqual(cache.metrics()['residentBytes'], 400)
        self.assertEqual(cache.metrics()['residentBytes'], 0)
        self.assertEqual(cache.metrics()['protectedBytes'], 0)
        self.assertEqual(cache.metrics()['budgetBytes'], 100)

    def test_clear_cannot_republish_a_pinned_old_value(self):
        cache = DecodedAnalysisCache(100)
        old = {'old': True}
        cache.put('v1', old, 100, reloadable=True)
        with cache.borrow('v1') as retained:
            cache.discard('v1')
            self.assertIsNone(cache.get('v1'))
            cache.put('v2', {'new': True}, 100, reloadable=False)
            self.assertIs(retained, old)
        self.assertEqual(cache.metrics()['entries'], 1)
        self.assertEqual(cache.metrics()['residentBytes'], 100)

    def test_invalid_budgets_and_replaced_immutable_identity_rejected(self):
        cache = DecodedAnalysisCache(100)
        value = {}
        cache.put('same', value, 50, reloadable=False)
        cache.put('same', value, 50, reloadable=False)
        with self.assertRaises(ValueError):
            cache.put('same', {}, 50, reloadable=True)
        for budget in (0, -1, True, 1.5):
            with self.assertRaises(ValueError):
                cache.set_budget(budget)


if __name__ == '__main__':
    unittest.main()
