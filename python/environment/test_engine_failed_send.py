import io
import unittest
from unittest.mock import Mock

from engine_process_client import EngineProcessClient


class EngineFailedSendTests(unittest.TestCase):
    def test_failed_serialization_or_closed_pipe_does_not_leave_pending_request(self):
        circular = {}
        circular['self'] = circular
        for params, closed, error_type in (
            ({'unsupported': object()}, False, TypeError),
            (circular, False, ValueError),
            ({}, True, ValueError),
        ):
            with self.subTest(closed=closed, error_type=error_type):
                client = EngineProcessClient('test')
                process = Mock()
                process.poll.return_value = None
                process.stdin = io.StringIO()
                if closed:
                    process.stdin.close()
                client._process = process
                unrelated = {'process': object()}
                client._pending['unrelated'] = unrelated
                try:
                    with self.assertRaises(error_type):
                        client._request_started('analysis.run', params, timeout=0)
                    self.assertEqual(client._pending, {'unrelated': unrelated})
                    if not closed:
                        self.assertEqual(process.stdin.getvalue(), '')
                finally:
                    client._process = None


if __name__ == '__main__':
    unittest.main()
