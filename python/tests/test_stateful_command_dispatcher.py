import threading
import unittest
from types import SimpleNamespace
from unittest import mock

from rms_backend.stateful_command_dispatcher import StatefulCommandDispatcher


class StatefulCommandDispatcherTests(unittest.TestCase):
    def setUp(self):
        self.configure_thinking_time = mock.Mock()
        self.run_debug_scenario = mock.Mock(return_value=False)
        self.view_builder = SimpleNamespace(
            build_status_response=mock.Mock(return_value={"status": True}),
            build_response=mock.Mock(return_value={"state": True}),
        )
        self.analysis = SimpleNamespace(
            start_auto=mock.Mock(return_value={"analysis": True}),
        )
        self.record = SimpleNamespace(
            import_record=mock.Mock(return_value={"record": True}),
        )
        self.view_control = SimpleNamespace(
            set_mode=mock.Mock(return_value={"mode": True}),
        )
        self.gameplay = SimpleNamespace(
            submit=mock.Mock(return_value={"gameplay": True}),
        )
        self.dispatcher = StatefulCommandDispatcher(
            state_lock=threading.RLock(),
            configure_thinking_time=self.configure_thinking_time,
            run_debug_scenario=self.run_debug_scenario,
            view_builder=self.view_builder,
            analysis_commands=self.analysis,
            record_commands=self.record,
            view_control_commands=self.view_control,
            gameplay_commands=self.gameplay,
        )

    def test_routes_payload_to_owning_domain(self):
        payload = {"path": "game.mjstudio"}

        result = self.dispatcher.dispatch(
            "request",
            "import_game_record",
            payload,
        )

        self.assertEqual(result, {"record": True})
        self.record.import_record.assert_called_once_with(
            "request",
            "import_game_record",
            payload,
        )
        self.configure_thinking_time.assert_called_once_with()

    def test_debug_scenario_returns_fresh_view(self):
        self.run_debug_scenario.return_value = True

        result = self.dispatcher.dispatch("request", "debug_case", None)

        self.assertEqual(result, {"state": True})
        self.view_builder.build_response.assert_called_once_with(
            "request",
            "debug_case",
        )

    def test_unknown_command_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Unsupported command: unknown"):
            self.dispatcher.dispatch("request", "unknown", {})


if __name__ == "__main__":
    unittest.main()
