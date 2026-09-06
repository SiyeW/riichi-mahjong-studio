import unittest
from unittest.mock import Mock, patch

from action_recommendation_gateway import ActionRecommendationGateway
from action_recommendation_adapter import resolve_engine_weight_path


class DecisionCandidateValidationTests(unittest.TestCase):
    def test_duplicate_candidates_leave_activity_unchanged_before_engine_calls(self):
        for ready in (False, True):
            with self.subTest(ready=ready):
                gateway = ActionRecommendationGateway()
                gateway._external_engine = True
                gateway._unloaded = False
                gateway._activity_state = 'idle'
                if ready:
                    gateway._ready_models.add(resolve_engine_weight_path('unused'))
                callback = Mock()
                gateway.set_activity_callback(callback)
                candidates = [{'id': 'duplicate', 'type': 'none'},
                              {'id': 'duplicate', 'type': 'none'}]
                with patch.object(gateway, '_initialize') as initialize, \
                     patch.object(gateway._client, 'request') as request:
                    with self.assertRaisesRegex(ValueError, 'duplicate legal candidate'):
                        gateway.analyze_candidates(0, 'unused', 'test', [], candidates)
                    initialize.assert_not_called()
                    request.assert_not_called()
                self.assertEqual(gateway.activity_state(), 'idle')
                self.assertIsNone(gateway.activity_error())
                callback.assert_not_called()


if __name__ == '__main__':
    unittest.main()
