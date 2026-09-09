import unittest
from unittest.mock import Mock, patch

from rms_backend.engine_process_client import EngineProcessClient, EngineProcessError, PROTOCOL


class EngineResponsePublicationTests(unittest.TestCase):
    def test_hello_and_initialization_reject_retired_response(self):
        for stage in ('hello', 'initialize'):
            for transition in ('exited', 'replaced', 'polled_exit'):
                with self.subTest(stage=stage, transition=transition):
                    client = EngineProcessClient('test')
                    process = Mock()
                    process.poll.return_value = None
                    client._process = process

                    def response(*args, **kwargs):
                        if transition == 'exited':
                            client._process = None
                        elif transition == 'replaced':
                            client._process = Mock()
                        else:
                            process.poll.return_value = 1
                        return {'protocol': dict(PROTOCOL), 'engine': {}}

                    try:
                        with patch.object(client, '_request_started', side_effect=response), \
                             patch.object(client, '_validate_hello'), \
                             patch.object(client, '_spawn'):
                            with self.assertRaisesRegex(EngineProcessError, 'response publication'):
                                if stage == 'hello':
                                    client._ensure_started()
                                else:
                                    with patch.object(client, '_ensure_started'):
                                        client.initialize([], [])
                        self.assertIsNone(client._hello)
                        self.assertIsNone(client._initialized)
                    finally:
                        client._process = None

    def test_live_response_is_published(self):
        client = EngineProcessClient('test')
        process = Mock()
        process.poll.return_value = None
        client._process = process
        hello = {'protocol': dict(PROTOCOL), 'engine': {}}
        try:
            with patch.object(client, '_spawn'), patch.object(client, '_validate_hello'), \
                 patch.object(client, '_request_started', return_value=hello):
                client._ensure_started()
            self.assertEqual(client.hello, hello)
            with patch.object(client, '_ensure_started'), \
                 patch.object(client, '_request_started', return_value={'outputs': []}):
                self.assertEqual(client.initialize([], []), {'outputs': []})
            self.assertEqual(client.initialized, {'outputs': []})
        finally:
            client._process = None


if __name__ == '__main__':
    unittest.main()
