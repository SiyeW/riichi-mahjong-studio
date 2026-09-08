import threading
import unittest
from types import SimpleNamespace
from unittest import mock

from command_transport import CommandTransport


class CommandTransportTests(unittest.TestCase):
    def setUp(self):
        self.view_builder = SimpleNamespace(
            build_status_response=mock.Mock(
                return_value={"command": "get_status"}
            ),
            build_response=mock.Mock(return_value={"command": "reload_engines"}),
        )
        self.engine_management = SimpleNamespace(
            describe=mock.Mock(return_value={"name": "engine"}),
            reload=mock.Mock(return_value={"reloaded": True}),
            unload=mock.Mock(return_value={"loaded": False}),
        )
        self.collect_metrics = mock.Mock(return_value={"backendPrivateBytes": 1})
        self.dispatch_stateful = mock.Mock(return_value={"command": "stateful"})
        self.emit = mock.Mock()
        self.transport = CommandTransport(
            state_lock=threading.RLock(),
            view_builder=self.view_builder,
            engine_management=self.engine_management,
            collect_runtime_metrics=self.collect_metrics,
            dispatch_stateful=self.dispatch_stateful,
            emit=self.emit,
            now_iso=lambda: "now",
        )

    def test_lightweight_status_bypasses_stateful_dispatch(self):
        self.transport.process(
            "request",
            "get_status",
            {},
            lightweight_status=True,
        )

        self.emit.assert_called_once_with({"command": "get_status"})
        self.dispatch_stateful.assert_not_called()

    def test_reload_builds_view_after_engine_reload(self):
        self.transport.process(
            "request",
            "reload_engines",
            {"profileId": "profile.test"},
        )

        self.engine_management.reload.assert_called_once_with("profile.test")
        self.view_builder.build_response.assert_called_once_with(
            "request",
            "reload_engines",
            {"reload": {"reloaded": True}},
        )
        self.emit.assert_called_once_with({"command": "reload_engines"})

    def test_stateful_command_is_delegated(self):
        payload = {"value": 1}
        self.transport.process("request", "custom", payload)

        self.dispatch_stateful.assert_called_once_with(
            "request",
            "custom",
            payload,
        )
        self.emit.assert_called_once_with({"command": "stateful"})

    def test_failure_is_returned_as_transport_error(self):
        self.dispatch_stateful.side_effect = ValueError("failed")

        self.transport.process("request", "custom", {})

        self.emit.assert_called_once_with(
            {
                "request_id": "request",
                "command": "custom",
                "error": "failed",
                "timestamp": "now",
            }
        )


if __name__ == "__main__":
    unittest.main()
