import threading
import unittest
from types import SimpleNamespace
from unittest import mock

from rms_backend.stateful_command_dispatcher import StatefulCommandDispatcher

REPLACEMENT_CASES = (
    ('create_game', 'prepare_create', 'activate_created'),
    ('import_game_record', 'prepare_import', 'activate_import'),
    ('import_mortal_report', 'prepare_reconstruction', 'activate_reconstruction'),
    ('import_custom_tenhou', 'prepare_reconstruction', 'activate_reconstruction'),
    ('import_replay_file', 'prepare_reconstruction', 'activate_reconstruction'),
)


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
            prepare_import=mock.Mock(return_value='prepared'),
            activate_import=mock.Mock(return_value={"record": True}),
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
        self.record.prepare_import.assert_called_once_with(payload)
        self.record.activate_import.assert_called_once_with(
            "request",
            "import_game_record",
            'prepared',
        )
        self.configure_thinking_time.assert_called_once_with()

    def test_import_preparation_does_not_hold_live_state_lock(self):
        ready = threading.Event()
        def prepare(_payload):
            def status():
                with self.dispatcher._state_lock:
                    ready.set()
            reader = threading.Thread(target=status)
            reader.start()
            self.assertTrue(ready.wait(1), 'File preparation blocked live state readers')
            reader.join()
            return 'candidate'
        self.record.prepare_import.side_effect = prepare
        self.dispatcher.dispatch(1, 'import_game_record', {'path': 'test'})

    def test_every_replacement_prepares_without_lock_and_activates_under_lock(self):
        for command, prepare_name, activate_name in REPLACEMENT_CASES:
            with self.subTest(command=command):
                old, candidate = object(), object()
                live = {'game': old}
                payload = {'path': 'isolated-record'}
                prepared_args = () if command == 'create_game' else ((payload,) if command == 'import_game_record' else (command, payload))
                blocked, readers = threading.Event(), []

                def prepare(*args):
                    self.assertEqual(args, prepared_args)
                    ready = threading.Event()
                    def read_current():
                        with self.dispatcher._state_lock:
                            self.assertIs(live['game'], old)
                            ready.set()
                    reader = threading.Thread(target=read_current)
                    readers.append(reader)
                    reader.start()
                    self.assertTrue(ready.wait(1), 'Replacement preparation blocked live-state reads')
                    return candidate

                def activate(request_id, actual_command, prepared):
                    self.assertEqual((request_id, actual_command), ('request', command))
                    self.assertIs(prepared, candidate)
                    attempted = threading.Event()
                    def read_after_commit():
                        attempted.set()
                        with self.dispatcher._state_lock:
                            blocked.set()
                    reader = threading.Thread(target=read_after_commit)
                    readers.append(reader)
                    reader.start()
                    self.assertTrue(attempted.wait(1))
                    self.assertFalse(blocked.wait(.02), 'Replacement activation did not own the live-state lock')
                    live['game'] = prepared
                    return {'activated': actual_command}

                self.dispatcher._record = SimpleNamespace(**{
                    prepare_name: mock.Mock(side_effect=prepare),
                    activate_name: mock.Mock(side_effect=activate),
                })
                try:
                    result = self.dispatcher.dispatch('request', command, payload)
                    self.assertEqual(result, {'activated': command})
                    self.assertIs(live['game'], candidate)
                    self.assertTrue(blocked.wait(1), 'Activation did not release its lock')
                finally:
                    for reader in readers:
                        reader.join(1)
                        self.assertFalse(reader.is_alive())

    def test_every_failed_replacement_preparation_leaves_the_old_record_untouched(self):
        for command, prepare_name, activate_name in REPLACEMENT_CASES:
            with self.subTest(command=command):
                old = {'comment': 'unsaved'}
                live = {'game': old}
                def activate(*_args):
                    live['game'] = {'replaced': True}
                prepared = mock.Mock(side_effect=ValueError('invalid candidate'))
                activated = mock.Mock(side_effect=activate)
                self.dispatcher._record = SimpleNamespace(**{prepare_name: prepared, activate_name: activated})
                self.configure_thinking_time.reset_mock()
                with self.assertRaisesRegex(ValueError, 'invalid candidate'):
                    self.dispatcher.dispatch('request', command, {'path': 'damaged'})
                self.assertIs(live['game'], old)
                activated.assert_not_called()
                self.configure_thinking_time.assert_not_called()

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
