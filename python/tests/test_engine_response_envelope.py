import unittest
from unittest.mock import Mock, patch

from rms_backend.engine_process_client import EngineProcessClient, EngineProcessError


class EngineResponseEnvelopeTests(unittest.TestCase):
    def request(self, payload):
        client = EngineProcessClient('test')
        process = Mock()
        process.poll.return_value = None
        client._process = process

        def respond(_process, request):
            pending = client._pending.pop(request['id'])
            pending['response'] = {'jsonrpc': '2.0', 'id': request['id'], **payload}
            pending['event'].set()

        try:
            with patch.object(client, '_write_message', side_effect=respond):
                return client._request_started('session.reset', {}, timeout=0)
        finally:
            self.assertEqual(client._pending, {})
            client._process = None

    def test_invalid_envelopes_cannot_look_like_success(self):
        for payload in (
            {}, {'result': {}, 'error': {'code': -1, 'message': 'failed'}},
            {'error': None}, {'error': 'failed'}, {'error': {}},
            {'error': {'code': True, 'message': 'failed'}},
            {'error': {'code': -1, 'message': 4}},
        ):
            with self.subTest(payload=payload):
                with self.assertRaises(EngineProcessError):
                    self.request(payload)

    def test_valid_error_preserves_code_and_diagnostics(self):
        with self.assertRaises(EngineProcessError) as raised:
            self.request({'error': {'code': -32000, 'message': 'failed', 'data': {'recoverable': True}}})
        self.assertEqual(raised.exception.code, -32000)
        self.assertEqual(raised.exception.data, {'recoverable': True})
        self.assertEqual(str(raised.exception), 'failed')

    def test_empty_and_populated_results_remain_valid(self):
        for result in ({}, {'ok': True}):
            self.assertEqual(self.request({'result': result}), result)


if __name__ == '__main__':
    unittest.main()
