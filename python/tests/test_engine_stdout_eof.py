import io
import subprocess
import threading
import unittest
from unittest.mock import Mock

from rms_backend.engine_process_client import EngineProcessClient


class EngineStdoutEofTests(unittest.TestCase):
    def test_live_process_is_reaped_before_reference_is_discarded(self):
        for needs_kill in (False, True):
            with self.subTest(needs_kill=needs_kill):
                callback = Mock()
                client = EngineProcessClient('test', callback)
                process = Mock()
                process.stdin = io.StringIO()
                process.stdout = io.StringIO()
                process.stderr = io.StringIO()
                client._process = process
                client._hello = {'old': True}
                client._initialized = {'old': True}
                pending = {'process': process, 'event': threading.Event()}
                client._pending['host-1'] = pending
                calls = []

                def wait(timeout):
                    self.assertIs(client._process, process)
                    calls.append(timeout)
                    if len(calls) <= (2 if needs_kill else 1):
                        raise subprocess.TimeoutExpired('test', timeout)
                    return -1

                process.wait.side_effect = wait
                try:
                    client._read_stdout(process)
                    process.terminate.assert_called_once_with()
                    if needs_kill:
                        process.kill.assert_called_once_with()
                    else:
                        process.kill.assert_not_called()
                    self.assertEqual(calls, [1, 1, 2] if needs_kill else [1, 1])
                    self.assertIsNone(client._process)
                    self.assertIsNone(client.hello)
                    self.assertIsNone(client.initialized)
                    self.assertTrue(pending['event'].is_set())
                    self.assertIn('exited', pending['error'])
                    callback.assert_called_once()
                    self.assertTrue(process.stdout.closed)
                    self.assertTrue(process.stdin.closed)
                finally:
                    client._process = None


if __name__ == '__main__':
    unittest.main()
