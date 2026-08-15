import unittest
from unittest import mock

from engine_runtime import (
    EngineProfileRuntime,
    EngineRuntimeRegistry,
    initialize_engine_client,
)


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


class FakeProcessClient:
    instances = []
    hello = {}
    result = {}

    def __init__(self, *_args, **_kwargs):
        self.initialize_calls = []
        self.restart_calls = 0
        self.shutdown_calls = 0
        FakeProcessClient.instances.append(self)

    def describe(self):
        return self.hello

    def initialize(self, outputs, weights, **options):
        self.initialize_calls.append((outputs, weights, options))
        return self.result

    def request(self, _method, _params, **_options):
        return {"outputs": []}

    def restart(self):
        self.restart_calls += 1

    def shutdown(self):
        self.shutdown_calls += 1


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

    def test_ignores_unsupported_outputs_and_their_weights(self):
        supported = {"id": "opponent-shanten", "version": 1}
        configured = [
            {"id": "action-recommendation", "version": 1},
            supported,
        ]
        hello = {
            "outputContracts": [
                {"id": "action-recommendation", "version": 2},
                supported,
                {"id": "future-output", "version": 1},
            ],
            "weightSlots": [
                {
                    "id": "supported",
                    "formats": [{"id": "onnx"}],
                    "requiredForOutputs": [supported],
                },
                {
                    "id": "future",
                    "formats": [{"id": "future"}],
                    "requiredForOutputs": [{"id": "future-output", "version": 1}],
                },
            ],
            "devices": [{"type": "cpu"}],
        }
        result = {"outputs": [supported], "device": {"type": "cpu"}}
        client = FakeClient(hello, result)

        initialized = initialize_engine_client(
            client,
            enabled_outputs=configured,
            weights=[
                {"slotId": "supported", "format": "onnx", "path": "supported.onnx"},
                {"slotId": "future", "format": "future", "path": "future.bin"},
            ],
            device_preference="cpu",
            options={},
            timeout=90,
        )

        self.assertEqual(set(initialized.outputs), {("opponent-shanten", 1)})
        self.assertEqual(client.initialize_calls, [(
            [supported],
            [{"slotId": "supported", "format": "onnx", "path": "supported.onnx"}],
            {"device": "cpu", "options": {}, "timeout": 90},
        )])

    def _runtime_specification(self):
        return {
            "profile_id": "profile.example",
            "engine_id": "example.engine",
            "engine_version": "1.0.0",
            "command": ["engine.exe"],
            "cwd": None,
            "enabled_outputs": self.outputs,
            "weights": self.weights,
            "device_preference": "cuda",
            "options": {"example": True},
        }

    def test_profile_runtime_initializes_all_assigned_outputs_once(self):
        FakeProcessClient.instances = []
        FakeProcessClient.hello = self.hello
        FakeProcessClient.result = self.result
        with mock.patch("engine_runtime.EngineProcessClient", FakeProcessClient):
            runtime = EngineProfileRuntime(**self._runtime_specification())
            action = runtime.initialize(
                [self.outputs[0]],
                self.weights,
                device="cuda",
                options={},
            )
            opponent = runtime.initialize(
                [self.outputs[1]],
                self.weights,
                device="cuda",
                options={},
            )

        process = FakeProcessClient.instances[0]
        self.assertEqual(len(process.initialize_calls), 1)
        self.assertEqual(process.initialize_calls[0][0], self.outputs)
        self.assertEqual(action["outputs"], [self.result["outputs"][1]])
        self.assertEqual(opponent["outputs"], [self.result["outputs"][0]])

    def test_unsupported_output_does_not_block_another_profile_output(self):
        supported = self.outputs[1]
        hello = {
            **self.hello,
            "outputContracts": [
                {"id": "action-recommendation", "version": 2},
                supported,
            ],
        }
        result = {"outputs": [supported], "device": {"type": "cpu"}}
        FakeProcessClient.instances = []
        FakeProcessClient.hello = hello
        FakeProcessClient.result = result
        with mock.patch("engine_runtime.EngineProcessClient", FakeProcessClient):
            runtime = EngineProfileRuntime(**self._runtime_specification())
            with self.assertRaisesRegex(RuntimeError, "does not provide action-recommendation version 1"):
                runtime.initialize([self.outputs[0]], self.weights)
            opponent = runtime.initialize([supported], self.weights)

        process = FakeProcessClient.instances[0]
        self.assertEqual(process.initialize_calls[0][0], [supported])
        self.assertEqual(opponent["outputs"], [supported])

    def test_registry_reuses_unchanged_profile_runtime(self):
        FakeProcessClient.instances = []
        with mock.patch("engine_runtime.EngineProcessClient", FakeProcessClient):
            registry = EngineRuntimeRegistry()
            specification = self._runtime_specification()
            registry.reconcile([specification])
            first = registry.get("profile.example")
            registry.reconcile([specification])
            second = registry.get("profile.example")

        self.assertIs(first, second)
        self.assertEqual(len(FakeProcessClient.instances), 1)

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
