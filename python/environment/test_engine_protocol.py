import os
import sys
import tempfile
import textwrap
import threading
import unittest
from pathlib import Path

from engine_process_client import EngineProcessClient, EngineProcessError


class EngineProtocolTest(unittest.TestCase):
    def test_hello_rejects_duplicate_output_contracts(self):
        hello = {
            "engine": {"id": "test.engine", "name": "Test", "version": "1.0.0"},
            "outputContracts": [
                {"id": "action-recommendation", "version": 1},
                {"id": "action-recommendation", "version": 1},
            ],
            "weightSlots": [],
            "devices": [{"type": "cpu"}],
            "runtimeCapabilities": {
                "multipleSessions": False,
                "concurrentRequests": False,
                "cancellation": False,
            },
            "optionsSchema": {"type": "object"},
        }
        with self.assertRaisesRegex(EngineProcessError, "invalid output contract"):
            EngineProcessClient._validate_hello(hello)

    def test_custom_command_uses_external_json_rpc_engine(self):
        script = textwrap.dedent(
            """
            import json
            import sys

            for line in sys.stdin:
                request = json.loads(line)
                method = request["method"]
                if method == "engine.hello":
                    result = {
                        "protocol": {
                            "name": "riichi-engine-protocol",
                            "major": 2,
                            "minor": 0,
                        },
                        "engine": {
                            "id": "third-party.mock",
                            "name": "Mock",
                            "version": "1.0.0",
                        },
                        "outputContracts": [{"id": "action-recommendation", "version": 1, "metrics": []}],
                        "weightSlots": [],
                        "devices": [{"type": "cpu", "title": {"default": "CPU"}}],
                        "runtimeCapabilities": {
                            "multipleSessions": False,
                            "concurrentRequests": False,
                            "cancellation": False,
                        },
                        "optionsSchema": {"type": "object"},
                    }
                elif method == "engine.getStatus":
                    result = {"state": "ready"}
                elif method == "engine.shutdown":
                    result = {"ok": True}
                else:
                    result = {}
                print(json.dumps({
                    "jsonrpc": "2.0",
                    "id": request.get("id"),
                    "result": result,
                }), flush=True)
                if method == "engine.shutdown":
                    break
            """
        )
        with tempfile.TemporaryDirectory() as directory:
            script_path = Path(directory) / "mock_engine.py"
            script_path.write_text(script, encoding="utf-8")
            client = EngineProcessClient(
                "custom",
                command=[sys.executable, str(script_path)],
                cwd=directory,
            )
            try:
                status = client.request("engine.getStatus")
                self.assertEqual(status["state"], "ready")
                self.assertEqual(client.hello["engine"]["id"], "third-party.mock")
            finally:
                client.shutdown()

    def test_hello_status_notification_and_shutdown(self):
        notifications = []
        script = textwrap.dedent(
            """
            import json
            import sys

            for line in sys.stdin:
                request = json.loads(line)
                method = request["method"]
                if method == "engine.hello":
                    result = {
                        "protocol": {"name": "riichi-engine-protocol", "major": 2, "minor": 0},
                        "engine": {
                            "id": "third-party.status",
                            "name": "Status",
                            "version": "1.0.0",
                        },
                        "outputContracts": [{"id": "opponent-shanten", "version": 1}],
                        "weightSlots": [],
                        "devices": [{"type": "cpu", "title": {"default": "CPU"}}],
                        "runtimeCapabilities": {
                            "multipleSessions": False,
                            "concurrentRequests": False,
                            "cancellation": False,
                        },
                        "optionsSchema": {"type": "object"},
                    }
                    print(json.dumps({
                        "jsonrpc": "2.0",
                        "method": "engine.status",
                        "params": {"state": "starting"},
                    }), flush=True)
                elif method == "engine.getStatus":
                    result = {"state": "starting"}
                else:
                    result = {"ok": True}
                print(json.dumps({
                    "jsonrpc": "2.0",
                    "id": request.get("id"),
                    "result": result,
                }), flush=True)
                if method == "engine.shutdown":
                    break
            """
        )
        with tempfile.TemporaryDirectory() as directory:
            script_path = Path(directory) / "status_engine.py"
            script_path.write_text(script, encoding="utf-8")
            client = EngineProcessClient(
                "opponent-analysis",
                lambda method, params: notifications.append((method, params)),
                command=[sys.executable, str(script_path)],
                cwd=directory,
            )
            try:
                status = client.request("engine.getStatus")
                self.assertEqual(status["state"], "starting")
                self.assertEqual(client.hello["protocol"]["major"], 2)
                self.assertEqual(client.hello["engine"]["id"], "third-party.status")
                self.assertTrue(
                    any(
                        method == "engine.status" and params.get("state") == "starting"
                        for method, params in notifications
                    )
                )
            finally:
                client.shutdown()

    def test_structured_error_is_exposed(self):
        script = textwrap.dedent(
            """
            import json
            import sys

            for line in sys.stdin:
                request = json.loads(line)
                if request["method"] == "engine.hello":
                    print(json.dumps({
                        "jsonrpc": "2.0",
                        "id": request.get("id"),
                        "result": {
                            "protocol": {"name": "riichi-engine-protocol", "major": 2, "minor": 0},
                            "engine": {
                                "id": "third-party.error",
                                "name": "Error",
                                "version": "1.0.0",
                            },
                            "outputContracts": [{"id": "action-recommendation", "version": 1, "metrics": []}],
                            "weightSlots": [],
                            "devices": [{"type": "cpu", "title": {"default": "CPU"}}],
                            "runtimeCapabilities": {
                                "multipleSessions": False,
                                "concurrentRequests": False,
                                "cancellation": False,
                            },
                            "optionsSchema": {"type": "object"},
                        },
                    }), flush=True)
                else:
                    print(json.dumps({
                        "jsonrpc": "2.0",
                        "id": request.get("id"),
                        "error": {
                            "code": -32000,
                            "message": "engine is not initialized",
                        },
                    }), flush=True)
            """
        )
        with tempfile.TemporaryDirectory() as directory:
            script_path = Path(directory) / "error_engine.py"
            script_path.write_text(script, encoding="utf-8")
            client = EngineProcessClient(
                "decision-test",
                command=[sys.executable, str(script_path)],
                cwd=directory,
            )
            try:
                with self.assertRaises(EngineProcessError) as raised:
                    client.request("analysis.run", {"events": []})
                self.assertEqual(raised.exception.code, -32000)
                self.assertIn("not initialized", str(raised.exception))
            finally:
                client.shutdown()

    def test_expected_engine_identity_is_verified_during_handshake(self):
        script = textwrap.dedent(
            """
            import json
            import sys

            for line in sys.stdin:
                request = json.loads(line)
                print(json.dumps({
                    "jsonrpc": "2.0",
                    "id": request.get("id"),
                    "result": {
                        "protocol": {
                            "name": "riichi-engine-protocol",
                            "major": 2,
                            "minor": 0,
                        },
                        "engine": {
                            "id": "third-party.wrong",
                            "name": "Wrong",
                            "version": "1.0.0",
                        },
                        "outputContracts": [{"id": "action-recommendation", "version": 1, "metrics": []}],
                        "weightSlots": [],
                        "devices": [{"type": "cpu", "title": {"default": "CPU"}}],
                        "runtimeCapabilities": {
                            "multipleSessions": False,
                            "concurrentRequests": False,
                            "cancellation": False,
                        },
                        "optionsSchema": {"type": "object"},
                    },
                }), flush=True)
            """
        )
        with tempfile.TemporaryDirectory() as directory:
            script_path = Path(directory) / "wrong_engine.py"
            script_path.write_text(script, encoding="utf-8")
            client = EngineProcessClient(
                "custom",
                command=[sys.executable, str(script_path)],
                cwd=directory,
                expected_engine_id="third-party.expected",
            )
            try:
                with self.assertRaisesRegex(
                    EngineProcessError,
                    "engine identity mismatch",
                ):
                    client.request("engine.getStatus")
            finally:
                client.shutdown()

    def test_external_engine_does_not_inherit_unrelated_environment_secrets(self):
        script = textwrap.dedent(
            """
            import json
            import os
            import sys

            for line in sys.stdin:
                request = json.loads(line)
                method = request["method"]
                if method == "engine.hello":
                    result = {
                        "protocol": {
                            "name": "riichi-engine-protocol",
                            "major": 2,
                            "minor": 0,
                        },
                        "engine": {
                            "id": "third-party.safe-env",
                            "name": "Safe env",
                            "version": "1.0.0",
                        },
                        "outputContracts": [{"id": "action-recommendation", "version": 1, "metrics": []}],
                        "weightSlots": [],
                        "devices": [{"type": "cpu", "title": {"default": "CPU"}}],
                        "runtimeCapabilities": {
                            "multipleSessions": False,
                            "concurrentRequests": False,
                            "cancellation": False,
                        },
                        "optionsSchema": {"type": "object"},
                    }
                elif method == "engine.getStatus":
                    result = {
                        "state": "ready",
                        "secretVisible": "MJAI_TEST_SECRET" in os.environ,
                    }
                else:
                    result = {"ok": True}
                print(json.dumps({
                    "jsonrpc": "2.0",
                    "id": request.get("id"),
                    "result": result,
                }), flush=True)
                if method == "engine.shutdown":
                    break
            """
        )
        previous = os.environ.get("MJAI_TEST_SECRET")
        os.environ["MJAI_TEST_SECRET"] = "must-not-leak"
        try:
            with tempfile.TemporaryDirectory() as directory:
                script_path = Path(directory) / "safe_env_engine.py"
                script_path.write_text(script, encoding="utf-8")
                client = EngineProcessClient(
                    "custom",
                    command=[sys.executable, str(script_path)],
                    cwd=directory,
                    expected_engine_id="third-party.safe-env",
                )
                try:
                    status = client.request("engine.getStatus")
                    self.assertFalse(status["secretVisible"])
                finally:
                    client.shutdown()
        finally:
            if previous is None:
                os.environ.pop("MJAI_TEST_SECRET", None)
            else:
                os.environ["MJAI_TEST_SECRET"] = previous

    def test_unexpected_exit_publishes_engine_error_status(self):
        script = textwrap.dedent(
            """
            import json
            import os
            import sys

            for line in sys.stdin:
                request = json.loads(line)
                if request["method"] == "engine.hello":
                    print(json.dumps({
                        "jsonrpc": "2.0",
                        "id": request.get("id"),
                        "result": {
                            "protocol": {
                                "name": "riichi-engine-protocol",
                                "major": 2,
                                "minor": 0,
                            },
                            "engine": {
                                "id": "third-party.crash",
                                "name": "Crash",
                                "version": "1.0.0",
                            },
                            "outputContracts": [{"id": "action-recommendation", "version": 1, "metrics": []}],
                            "weightSlots": [],
                            "devices": [{"type": "cpu", "title": {"default": "CPU"}}],
                            "runtimeCapabilities": {
                                "multipleSessions": False,
                                "concurrentRequests": False,
                                "cancellation": False,
                            },
                            "optionsSchema": {"type": "object"},
                        },
                    }), flush=True)
                else:
                    os._exit(7)
            """
        )
        notifications = []
        error_seen = threading.Event()

        def on_notification(method, params):
            notifications.append((method, params))
            if method == "engine.status" and params.get("state") == "error":
                error_seen.set()

        with tempfile.TemporaryDirectory() as directory:
            script_path = Path(directory) / "crash_engine.py"
            script_path.write_text(script, encoding="utf-8")
            client = EngineProcessClient(
                "custom",
                on_notification,
                command=[sys.executable, str(script_path)],
                cwd=directory,
                expected_engine_id="third-party.crash",
            )
            try:
                with self.assertRaises(EngineProcessError):
                    client.request("engine.getStatus")
                self.assertTrue(error_seen.wait(timeout=2))
                self.assertEqual(
                    notifications[-1][1]["error"]["code"],
                    "ENGINE_CRASHED",
                )
            finally:
                client.shutdown()


if __name__ == "__main__":
    unittest.main()
