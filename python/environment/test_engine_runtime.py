import unittest

from engine_runtime import initialize_engine_client


class FakeClient:
    def __init__(self, hello, result):
        self.hello = hello
        self.result = result
        self.initialize_calls = []

    def describe(self):
        return self.hello

    def initialize(self, outputs, weights, **options):
        self.initialize_calls.append((outputs, weights, options))
        return self.result


class EngineRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.outputs = [
            {"id": "action-recommendation", "version": 1},
            {"id": "opponent-shanten", "version": 1},
        ]
        self.weights = [{"slotId": "shared", "format": "onnx", "path": "model.onnx"}]
        self.hello = {
            "outputContracts": [dict(output) for output in self.outputs],
            "weightSlots": [{
                "id": "shared",
                "formats": [{"id": "onnx"}],
                "requiredForOutputs": [dict(output) for output in self.outputs],
            }],
            "devices": [{"type": "cpu"}, {"type": "cuda"}],
        }
        self.result = {
            "outputs": [dict(output) for output in reversed(self.outputs)],
            "device": {"type": "cuda"},
            "effectiveOptions": {},
        }

    def test_initializes_all_outputs_of_one_configuration_together(self):
        client = FakeClient(self.hello, self.result)

        initialized = initialize_engine_client(
            client,
            enabled_outputs=self.outputs,
            weights=self.weights,
            device_preference="cuda",
            options={"example": True},
            timeout=90,
        )

        self.assertEqual(set(initialized.outputs), {
            ("action-recommendation", 1),
            ("opponent-shanten", 1),
        })
        self.assertEqual(initialized.device, "cuda")
        self.assertEqual(client.initialize_calls, [(
            self.outputs,
            self.weights,
            {"device": "cuda", "options": {"example": True}, "timeout": 90},
        )])

    def test_rejects_missing_required_weight(self):
        client = FakeClient(self.hello, self.result)

        with self.assertRaisesRegex(RuntimeError, "requires the shared weight"):
            initialize_engine_client(
                client,
                enabled_outputs=self.outputs,
                weights=[],
                device_preference="cpu",
                options={},
                timeout=90,
            )

    def test_rejects_missing_or_unexpected_outputs(self):
        client = FakeClient(
            self.hello,
            {"outputs": [dict(self.outputs[0])], "device": {"type": "cpu"}},
        )

        with self.assertRaisesRegex(RuntimeError, "unexpected outputs"):
            initialize_engine_client(
                client,
                enabled_outputs=self.outputs,
                weights=self.weights,
                device_preference="cpu",
                options={},
                timeout=90,
            )


if __name__ == "__main__":
    unittest.main()
