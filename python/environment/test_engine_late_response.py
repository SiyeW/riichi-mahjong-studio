import io
import json
import unittest
from unittest.mock import Mock, patch

from engine_process_client import EngineProcessClient, EngineProcessError


class EngineLateResponseTests(unittest.TestCase):
    def test_timed_out_response_cannot_complete_the_next_request(self):
        for old_payload in ({'result': {'old': True}},
                            {'error': {'code': -32000, 'message': 'old failure'}}):
            with self.subTest(old_payload=old_payload):
                client = EngineProcessClient('test')
                process = Mock()
                process.poll.return_value = None
                process.wait.return_value = 0
                process.stdin = io.StringIO()
                client._process = process
                client._stopping = True
                sent = []

                def write(_process, request):
                    sent.append(request['id'])
                    if len(sent) == 1:
                        return
                    responses = [
                        {'jsonrpc': '2.0', 'id': sent[0], **old_payload},
                        {'jsonrpc': '2.0', 'id': sent[1], 'result': {'current': True}},
                        {'jsonrpc': '2.0', 'id': sent[1], 'error': {'code': -1, 'message': 'duplicate'}},
                    ]
                    process.stdout = io.StringIO(''.join(json.dumps(item) + '\n' for item in responses))
                    client._read_stdout(process)

                try:
                    with patch.object(client, '_write_message', side_effect=write):
                        with self.assertRaisesRegex(EngineProcessError, 'timed out'):
                            client._request_started('analysis.run', {}, timeout=0)
                        self.assertEqual(client._pending, {})
                        self.assertEqual(client._request_started('analysis.run', {}, timeout=0), {'current': True})
                    self.assertNotEqual(sent[0], sent[1])
                    self.assertEqual(client._pending, {})
                finally:
                    client._process = None


if __name__ == '__main__':
    unittest.main()
