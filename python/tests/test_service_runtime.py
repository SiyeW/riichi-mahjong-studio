import unittest

from rms_backend.service_runtime import ServiceRuntime


class FakeExecutor:
    def __init__(self, *, max_workers):
        self.max_workers = max_workers
        self.calls = []
        self.shutdown_calls = []

    def submit(self, callback, *args, **kwargs):
        self.calls.append((callback, args, kwargs))

    def shutdown(self, **kwargs):
        self.shutdown_calls.append(kwargs)


class ServiceRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.runtime = ServiceRuntime(
            emit=self.events.append,
            now_iso=lambda: "now",
            executor_factory=FakeExecutor,
        )

    def tearDown(self):
        self.runtime.shutdown()

    def test_commands_use_independent_request_lanes(self):
        process = object()
        commands = [
            "get_status",
            "get_runtime_metrics",
            "describe_engine",
            "reload_engines",
            "get_game_view",
        ]
        for index, command in enumerate(commands):
            self.runtime.dispatch_line(
                f'{{"request_id": {index}, "command": "{command}"}}',
                process,
            )
        for command in commands:
            lane = self.runtime.request_lane(command)
            self.assertEqual(len(self.runtime._request_executors[lane].calls), 1)
        status_call = self.runtime._request_executors["status"].calls[0]
        self.assertEqual(status_call[2], {"lightweight_status": True})

    def test_shutdown_runs_owned_callbacks_in_reverse_order_once(self):
        calls = []
        self.runtime.add_shutdown(lambda: calls.append("first"))
        self.runtime.add_shutdown(lambda: calls.append("second"))
        self.runtime.shutdown()
        self.runtime.shutdown()
        self.assertEqual(calls, ["second", "first"])
        executors = [
            self.runtime.background,
            self.runtime.engine_prewarm,
            *self.runtime._request_executors.values(),
        ]
        self.assertTrue(all(executor.shutdown_calls == [
            {"wait": False, "cancel_futures": True}
        ] for executor in executors))

    def test_invalid_input_is_reported_without_scheduling(self):
        self.runtime.dispatch_line("not json", object())
        self.assertEqual(self.events[0]["request_id"], None)
        self.assertIn("Expecting value", self.events[0]["error"])


if __name__ == "__main__":
    unittest.main()
