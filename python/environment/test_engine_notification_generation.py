import io
import unittest
from unittest.mock import Mock, patch

from engine_process_client import EngineProcessClient


class EngineNotificationGenerationTests(unittest.TestCase):
    def test_delayed_crash_notification_is_rejected_after_restart(self):
        callback = Mock()
        client = EngineProcessClient('test', callback)
        process = Mock()
        process.stdin = io.StringIO()
        process.stdout = io.StringIO()
        process.wait.return_value = 1
        client._process = process
        notify = client._notify

        def delayed(method, params, **kwargs):
            self.assertIsNone(client._process)
            client.restart()
            notify(method, params, **kwargs)

        with patch.object(client, '_notify', side_effect=delayed):
            client._read_stdout(process)
        callback.assert_not_called()

    def test_current_crash_still_notifies(self):
        callback = Mock()
        client = EngineProcessClient('test', callback)
        process = Mock()
        process.stdin = io.StringIO()
        process.stdout = io.StringIO()
        process.wait.return_value = 1
        client._process = process
        client._read_stdout(process)
        callback.assert_called_once()
        self.assertEqual(callback.call_args.args[1]['error']['code'], 'ENGINE_CRASHED')

    def test_generation_guard_does_not_hold_process_lock_during_callback(self):
        client = EngineProcessClient('test')
        observed = []

        def callback(method, params):
            # A different thread must be able to acquire the process lock.
            from concurrent.futures import ThreadPoolExecutor

            def inspect():
                acquired = client._lock.acquire(timeout=1)
                if acquired:
                    client._lock.release()
                return acquired

            with ThreadPoolExecutor(max_workers=1) as executor:
                observed.append(executor.submit(inspect).result(timeout=2))

        client._notification_callback = callback
        client._notify('engine.status', {}, expected_generation=client._process_generation)
        self.assertEqual(observed, [True])


if __name__ == '__main__':
    unittest.main()
