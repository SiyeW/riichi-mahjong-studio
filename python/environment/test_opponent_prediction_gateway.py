import unittest

from opponent_prediction_coordinator import OpponentPredictionCoordinator
from opponent_prediction_gateway import OpponentPredictionGateway, TILE34_NAMES


class OpponentOutputCompositionTest(unittest.TestCase):
    class _FakeGateway:
        def __init__(self, profile_id):
            self.profile_id = profile_id
            self.ready = False
            self.unloaded = True
            self.prewarm_calls = 0
            self.prepare_calls = 0
            self.unload_calls = 0

        def runtime_status(self):
            return {
                "profileId": self.profile_id,
                "ready": self.ready,
                "unloaded": self.unloaded,
            }

        def prepare_reload(self):
            self.prepare_calls += 1
            self.unloaded = False

        def prewarm(self):
            self.prewarm_calls += 1
            self.ready = True
            return True

        def unload(self):
            self.unload_calls += 1
            self.ready = False
            self.unloaded = True

        def accepts_requests(self):
            return self.ready and not self.unloaded

        def get_latest(self):
            return {
                "predictions": {"opponents": {self.profile_id: [1.0]}, "ron_wait": {}},
                "ground_truth": {"opponents": {}, "ron_wait": {}},
                "status": "ready" if self.ready else "unloaded",
            }

        def cache_identity(self):
            return self.profile_id

    def test_profile_lifecycle_only_touches_the_selected_gateway(self):
        first = self._FakeGateway("profile.first")
        second = self._FakeGateway("profile.second")
        gateway = object.__new__(OpponentPredictionCoordinator)
        gateway._active = [first, second]

        gateway.prepare_reload("profile.first")
        self.assertTrue(gateway.prewarm("profile.first"))
        gateway.unload("profile.first")

        self.assertEqual(first.prepare_calls, 1)
        self.assertEqual(first.prewarm_calls, 1)
        self.assertEqual(first.unload_calls, 1)
        self.assertEqual(second.prepare_calls, 0)
        self.assertEqual(second.prewarm_calls, 0)
        self.assertEqual(second.unload_calls, 0)

    def test_runtime_status_keeps_profile_states_separate(self):
        first = self._FakeGateway("profile.first")
        second = self._FakeGateway("profile.second")
        first.ready = True
        first.unloaded = False
        gateway = object.__new__(OpponentPredictionCoordinator)
        gateway._active = [first, second]

        status = gateway.runtime_status()

        self.assertTrue(status["profiles"]["profile.first"]["ready"])
        self.assertFalse(status["profiles"]["profile.first"]["unloaded"])
        self.assertFalse(status["profiles"]["profile.second"]["ready"])
        self.assertTrue(status["profiles"]["profile.second"]["unloaded"])

    def test_unloaded_profiles_do_not_affect_available_results(self):
        first = self._FakeGateway("profile.first")
        second = self._FakeGateway("profile.second")
        first.ready = True
        first.unloaded = False
        gateway = object.__new__(OpponentPredictionCoordinator)
        gateway._active = [first, second]

        latest = gateway.get_latest()

        self.assertEqual(latest["status"], "ready")
        self.assertIn("profile.first", latest["predictions"]["opponents"])
        self.assertNotIn("profile.second", latest["predictions"]["opponents"])

    def test_shanten_contract_can_be_consumed_without_deal_in_output(self):
        gateway = OpponentPredictionGateway(enabled_outputs=["opponent-shanten"])
        try:
            players = gateway._validate_protocol_prediction(
                {
                    "outputs": [{
                        "id": "opponent-shanten",
                        "version": 1,
                        "data": {
                            "players": [
                                {
                                    "seat": seat,
                                    "shanten": [
                                        {"value": value, "probability": 1.0 if value == 1 else 0.0}
                                        for value in range(7)
                                    ],
                                    "furitenOrNoYaku": 0.25,
                                }
                                for seat in (1, 2, 3)
                            ],
                        },
                    }],
                },
                controlled_seat=0,
            )
            self.assertEqual(len(players), 3)
            self.assertTrue(all("shanten" in player for player in players))
            self.assertTrue(all("ronWaits" not in player for player in players))
        finally:
            gateway.shutdown()

    def test_deal_in_contract_can_be_consumed_without_shanten_output(self):
        gateway = OpponentPredictionGateway(
            enabled_outputs=["opponent-deal-in-probability"],
        )
        try:
            players = gateway._validate_protocol_prediction(
                {
                    "outputs": [{
                        "id": "opponent-deal-in-probability",
                        "version": 1,
                        "data": {
                            "players": [
                                {
                                    "seat": seat,
                                    "tiles": {tile: 0.01 for tile in TILE34_NAMES},
                                }
                                for seat in (1, 2, 3)
                            ],
                        },
                    }],
                },
                controlled_seat=0,
            )
            self.assertEqual(len(players), 3)
            self.assertTrue(all("ronWaits" in player for player in players))
            self.assertTrue(all("shanten" not in player for player in players))
        finally:
            gateway.shutdown()

    def test_partial_host_results_merge_without_overwriting_each_other(self):
        combined = OpponentPredictionCoordinator._merge_results([
            {
                "predictions": {"opponents": {"shimocha": [1.0]}, "ron_wait": {}},
                "ground_truth": {"opponents": {}, "ron_wait": {}},
                "raw": {"shimocha": {"seat": 1, "shanten_probs": [1.0]}},
                "context": {"nodeId": "n_1"},
                "status": "ready",
            },
            {
                "predictions": {"opponents": {}, "ron_wait": {"shimocha": [0.1]}},
                "ground_truth": {"opponents": {}, "ron_wait": {}},
                "raw": {"shimocha": {"seat": 1, "ron_wait": [0.1]}},
                "context": {"nodeId": "n_1"},
                "status": "ready",
            },
        ])
        self.assertEqual(combined["predictions"]["opponents"]["shimocha"], [1.0])
        self.assertEqual(combined["predictions"]["ron_wait"]["shimocha"], [0.1])
        self.assertIn("shanten_probs", combined["raw"]["shimocha"])
        self.assertIn("ron_wait", combined["raw"]["shimocha"])

    def test_additional_protocol_outputs_are_preserved_for_the_host(self):
        gateway = OpponentPredictionGateway(enabled_outputs=["kyoku-outcome"])
        try:
            output_data = {
                "drawProbability": 0.25,
                "players": [
                    {
                        "seat": seat,
                        "winProbability": 0.2,
                        "dealInProbability": 0.1,
                        "targetGivenWin": [
                            {"seat": target, "probability": 0.25}
                            for target in range(4)
                        ],
                    }
                    for seat in range(4)
                ],
            }
            players = gateway._validate_protocol_prediction(
                {
                    "outputs": [{
                        "id": "kyoku-outcome",
                        "version": 1,
                        "data": output_data,
                    }],
                },
                controlled_seat=0,
            )
            result = gateway._protocol_result_to_host(
                players,
                protocol_outputs={"kyoku-outcome": output_data},
                events=[],
                target_events=None,
                controlled_seat=0,
                context={"nodeId": "n_1"},
                target_prefix_hashes=None,
                target_event_hash=None,
            )
            self.assertEqual(result["outputs"]["kyoku-outcome"], output_data)
            self.assertEqual(result["context"], {"nodeId": "n_1"})
        finally:
            gateway.shutdown()

    def test_configure_profile_keeps_every_requested_analysis_output(self):
        gateway = OpponentPredictionGateway(enabled_outputs=["opponent-shanten"])
        try:
            gateway.configure_profile(
                profile_id="profile.unified",
                engine_id="org.example.unified",
                engine_version="1.0.0",
                model_id="",
                model_format="example-v1",
                model_path="weights/example.pt",
                enabled_outputs=[
                    "opponent-shanten",
                    "kyoku-outcome",
                    "match-score",
                ],
            )
            self.assertEqual(
                [output["id"] for output in gateway._requested_output_contracts()],
                ["opponent-shanten", "kyoku-outcome", "match-score"],
            )
        finally:
            gateway.shutdown()

    def test_merged_results_keep_additional_outputs(self):
        combined = OpponentPredictionCoordinator._merge_results([
            {
                "predictions": {"opponents": {}, "ron_wait": {}},
                "ground_truth": {"opponents": {}, "ron_wait": {}},
                "outputs": {"kyoku-outcome": {"drawProbability": 0.25}},
                "context": {"nodeId": "n_1"},
                "status": "ready",
            },
            {
                "predictions": {"opponents": {}, "ron_wait": {}},
                "ground_truth": {"opponents": {}, "ron_wait": {}},
                "outputs": {"match-score": {"players": []}},
                "context": {"nodeId": "n_1"},
                "status": "ready",
            },
        ])
        self.assertEqual(
            set(combined["outputs"]),
            {"kyoku-outcome", "match-score"},
        )


if __name__ == "__main__":
    unittest.main()
