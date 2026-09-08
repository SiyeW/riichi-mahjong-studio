import tempfile
import unittest
from pathlib import Path
from opponent_prediction_profile import (
    OpponentEngineIdentity,
    OpponentEngineProfile,
)


class OpponentPredictionProfileTests(unittest.TestCase):
    def test_configuration_normalizes_device_without_forwarding_it_as_option(self):
        profile = OpponentEngineProfile.configured(
            profile_id="profile.test",
            engine_id="org.example.engine",
            engine_version="",
            model_id="model.test",
            model_format="test-v1",
            model_path="weights/test.pt",
            expected_sha256="ABC",
            input_modes=["full-information", "unsupported"],
            engine_command=["python", 1],
            engine_cwd=None,
            engine_options={"device": "cuda", "batch": 4},
            enabled_outputs=["match-score", "opponent-shanten"],
            weights=None,
        )

        self.assertEqual(profile.device_preference, "cuda")
        self.assertEqual(profile.engine_options, {"batch": 4})
        self.assertEqual(profile.engine_version, "1.0.0")
        self.assertEqual(profile.expected_sha256, "abc")
        self.assertEqual(profile.input_modes, ("full-information",))
        self.assertEqual(
            profile.enabled_outputs,
            ("opponent-shanten", "match-score"),
        )
        self.assertEqual(profile.engine_command, ["python", "1"])

    def test_identity_uses_negotiated_fingerprint_when_available(self):
        profile = OpponentEngineProfile.initial(None, ["opponent-shanten"])
        identity = OpponentEngineIdentity(profile)

        identity.accept_initialization(
            references={"opponent-shanten": {"id": "opponent-shanten"}},
            protocol_minor=2,
            input_modes=("public",),
            effective_options={},
            actual_device="cpu",
            fingerprint="sha256:negotiated",
        )

        self.assertEqual(identity.cache_identity(), "sha256:negotiated")
        identity.clear_runtime()
        self.assertNotEqual(identity.cache_identity(), "sha256:negotiated")

    def test_weight_content_changes_fallback_cache_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            weight_path = Path(directory) / "weights.bin"
            weight_path.write_bytes(b"first")
            profile = OpponentEngineProfile.configured(
                profile_id="profile.test",
                engine_id="org.example.engine",
                engine_version="1.0.0",
                model_id="model.test",
                model_format="test-v1",
                model_path=str(weight_path),
                expected_sha256="",
                input_modes=None,
                engine_command=None,
                engine_cwd=None,
                engine_options=None,
                enabled_outputs=["opponent-shanten"],
                weights=[
                    {
                        "slotId": "model",
                        "format": "test-v1",
                        "path": str(weight_path),
                    }
                ],
            )
            identity = OpponentEngineIdentity(profile)
            first = identity.cache_identity()
            weight_path.write_bytes(b"second")

            self.assertNotEqual(first, identity.cache_identity())


if __name__ == "__main__":
    unittest.main()
