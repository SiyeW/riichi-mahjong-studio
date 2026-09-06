import io
import json
import threading
import unittest
from unittest.mock import Mock, patch

from engine_process_client import EngineProcessClient


def process_with_messages(messages):
    process = Mock()
    process.stdin = io.StringIO()
    process.stdout = io.StringIO(''.join(json.dumps(message) + '\n' for message in messages))
    process.stderr = io.StringIO('old diagnostic\n')
    process.wait.return_value = 0
    return process


class EngineReaderOwnershipTests(unittest.TestCase):
    def test_retired_reader_cannot_deliver_notification_or_response(self):
        callback = Mock()
        client = EngineProcessClient('test', callback)
        old = process_with_messages([
            {'jsonrpc': '2.0', 'method': 'engine.status', 'params': {'state': 'error'}},
            {'jsonrpc': '2.0', 'id': 'host-1', 'result': {'old': True}},
        ])
        current = Mock()
        client._process = current
        pending = {'process': current, 'event': threading.Event(), 'response': None}
        client._pending['host-1'] = pending
        try:
            client._read_stdout(old)
            callback.assert_not_called()
            self.assertIs(client._pending['host-1'], pending)
            self.assertFalse(pending['event'].is_set())
            self.assertIsNone(pending['response'])
            self.assertIs(client._process, current)
        finally:
            client._process = None

    def test_retired_stderr_does_not_pollute_current_diagnostics(self):
        client = EngineProcessClient('test')
        old = process_with_messages([])
        client._process = Mock()
        client._stderr_tail = ['current diagnostic']
        try:
            with patch('engine_process_client.sys.stderr', new_callable=io.StringIO) as output:
                client._read_stderr(old)
                self.assertEqual(output.getvalue(), '')
            self.assertEqual(client._stderr_tail, ['current diagnostic'])
        finally:
            client._process = None

    def test_current_reader_still_delivers_notification_and_response(self):
        callback = Mock()
        client = EngineProcessClient('test', callback)
        process = process_with_messages([
            {'jsonrpc': '2.0', 'method': 'engine.status', 'params': {'state': 'ready'}},
            {'jsonrpc': '2.0', 'id': 'host-1', 'result': {'ok': True}},
        ])
        client._process = process
        client._stopping = True
        pending = {'process': process, 'event': threading.Event(), 'response': None}
        client._pending['host-1'] = pending
        client._read_stdout(process)
        callback.assert_called_once_with('engine.status', {'state': 'ready'})
        self.assertTrue(pending['event'].is_set())
        self.assertEqual(pending['response']['result'], {'ok': True})


if __name__ == '__main__':
    unittest.main()
