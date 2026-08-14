import unittest

from engine_assignments import profiles_by_output, resolve_engine_assignments


class EngineAssignmentsTest(unittest.TestCase):
    def test_groups_multiple_outputs_assigned_to_one_profile(self):
        profile = {"id": "profile.unified", "name": "Unified"}
        config = {
            "engines": {
                "profiles": [profile],
                "outputAssignments": {
                    "action-recommendation": "profile.unified",
                    "opponent-shanten": "profile.unified",
                    "opponent-deal-in-probability": "profile.unified",
                },
            },
        }

        self.assertEqual(
            resolve_engine_assignments(config),
            [{
                "profileId": "profile.unified",
                "profile": profile,
                "outputs": [
                    "action-recommendation",
                    "opponent-shanten",
                    "opponent-deal-in-probability",
                ],
            }],
        )

    def test_preserves_profile_order_and_ignores_missing_profiles(self):
        first = {"id": "profile.first"}
        second = {"id": "profile.second"}
        config = {
            "engines": {
                "profiles": [first, second],
                "outputAssignments": {
                    "action-recommendation": "profile.second",
                    "opponent-shanten": "profile.missing",
                    "opponent-deal-in-probability": "profile.first",
                },
            },
        }

        self.assertEqual(
            resolve_engine_assignments(config),
            [
                {
                    "profileId": "profile.first",
                    "profile": first,
                    "outputs": ["opponent-deal-in-probability"],
                },
                {
                    "profileId": "profile.second",
                    "profile": second,
                    "outputs": ["action-recommendation"],
                },
            ],
        )

    def test_indexes_profiles_by_output(self):
        profile = {"id": "profile.example"}
        config = {
            "engines": {
                "profiles": [profile],
                "outputAssignments": {
                    "action-recommendation": "profile.example",
                    "opponent-shanten": "profile.example",
                },
            },
        }

        self.assertEqual(
            profiles_by_output(config),
            {
                "action-recommendation": profile,
                "opponent-shanten": profile,
            },
        )


if __name__ == "__main__":
    unittest.main()
