import copy
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from rms_backend.action_recommendation_gateway import ActionRecommendationGateway


class DecisionInitializationValidationTests(unittest.TestCase):
    def test_invalid_declarations_do_not_overwrite_current_metadata(self):
        metric = {'id': 'p', 'title': {'default': 'Probability'},
                  'format': 'percentage', 'preferredDirection': 'higher'}
        for declaration in [
            {'metrics': [metric, metric]},
            {'metrics': [metric], 'primaryMetricId': 'unknown'},
            {'metrics': [metric], 'recommendationMetricId': 'unknown'},
            {'metrics': [{**metric, 'format': 'points'}]},
        ]:
            with self.subTest(declaration=declaration):
                gateway = ActionRecommendationGateway()
                fields = ('_output_reference', '_protocol_minor', '_action_metrics',
                          '_primary_metric_id', '_recommendation_metric_id', '_effective_options',
                          '_actual_device', '_last_fingerprint')
                before = {field: copy.deepcopy(getattr(gateway, field)) for field in fields}
                initialized = SimpleNamespace(
                    result={}, contracts={'action-recommendation': {'metrics': [metric]}},
                    outputs={'action-recommendation': declaration},
                    references={'action-recommendation': {'id': 'action-recommendation', 'test': True}},
                    protocol_minor=99, device='test-device')
                with patch('rms_backend.action_recommendation_gateway.initialize_engine_client', return_value=initialized):
                    with self.assertRaises(RuntimeError):
                        gateway._initialize('unused', 1)
                self.assertEqual({field: getattr(gateway, field) for field in fields}, before)


if __name__ == '__main__':
    unittest.main()
