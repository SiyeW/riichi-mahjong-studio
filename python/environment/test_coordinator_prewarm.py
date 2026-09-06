import unittest
from unittest.mock import Mock

from opponent_prediction_coordinator import OpponentPredictionCoordinator


class CoordinatorPrewarmTests(unittest.TestCase):
    def coordinator(self, results):
        coordinator = OpponentPredictionCoordinator()
        for index, result in enumerate(results):
            gateway = Mock()
            gateway.prewarm.return_value = result
            gateway.runtime_status.return_value = {'profileId': str(index)}
            coordinator._active.append(gateway)
        return coordinator

    def test_failed_profile_does_not_skip_remaining_profiles(self):
        for results in ([False, True, True], [True, False, True]):
            with self.subTest(results=results):
                coordinator = self.coordinator(results)
                self.assertFalse(coordinator.prewarm())
                for gateway in coordinator._active:
                    gateway.prewarm.assert_called_once_with()

    def test_all_successful_profiles_report_ready(self):
        coordinator = self.coordinator([True, True])
        self.assertTrue(coordinator.prewarm())
        for gateway in coordinator._active:
            gateway.prewarm.assert_called_once_with()

    def test_explicit_profile_does_not_load_other_profiles(self):
        coordinator = self.coordinator([False, True])
        self.assertTrue(coordinator.prewarm('1'))
        coordinator._active[0].prewarm.assert_not_called()
        coordinator._active[1].prewarm.assert_called_once_with()

    def test_missing_profile_or_empty_configuration_is_not_ready(self):
        self.assertFalse(self.coordinator([]).prewarm())
        coordinator = self.coordinator([True])
        self.assertFalse(coordinator.prewarm('missing'))
        coordinator._active[0].prewarm.assert_not_called()


if __name__ == '__main__':
    unittest.main()
