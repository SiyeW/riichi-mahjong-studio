import unittest
from unittest.mock import Mock, patch

import service
from opponent_prediction_coordinator import OpponentPredictionCoordinator


class AnalysisInputModeTests(unittest.TestCase):
    def test_common_modes_are_intersected_across_active_profiles(self):
        coordinator = OpponentPredictionCoordinator()
        public = Mock()
        public.supported_input_modes.return_value = ('public',)
        revealed = Mock()
        revealed.supported_input_modes.return_value = ('public', 'full-information')
        for gateways, expected in [
            ([], ('public',)),
            ([public], ('public',)),
            ([revealed], ('public', 'full-information')),
            ([public, revealed], ('public',)),
            ([revealed, public], ('public',)),
            ([revealed, revealed], ('public', 'full-information')),
        ]:
            with self.subTest(expected=expected, count=len(gateways)):
                with patch.object(coordinator, '_request_gateways', return_value=gateways):
                    self.assertEqual(coordinator.supported_input_modes(), expected)

    def test_hidden_hands_never_select_revealed_input(self):
        with patch.dict(service.STATE, visibleHands=False), \
             patch.object(service.OPPONENT_PREDICTIONS, 'supported_input_modes',
                          return_value=('public', 'full-information')):
            self.assertEqual(service._get_opponent_analysis_input_mode(), 'public')

    def test_visible_hands_use_revealed_input_only_when_common_to_all_engines(self):
        for supported, expected in [(('public',), 'public'),
                                    (('public', 'full-information'), 'full-information')]:
            with self.subTest(supported=supported), \
                 patch.dict(service.STATE, visibleHands=True), \
                 patch.object(service.OPPONENT_PREDICTIONS, 'supported_input_modes', return_value=supported):
                self.assertEqual(service._get_opponent_analysis_input_mode(), expected)


if __name__ == '__main__':
    unittest.main()
