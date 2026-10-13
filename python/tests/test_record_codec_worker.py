import io
from pathlib import Path
import subprocess
import sys
import time
import unittest

from rms_backend.record_codec_client import RecordCodecClient, CodecWorkerError
from rms_backend.record_codec_worker import PACKET_HEADER, PACKET_LIMIT, read_packet, write_packet


class RecordCodecWorkerTests(unittest.TestCase):
    def test_lazy_persistent_process_no_service_or_models_and_canonical_roundtrip(self):
        with RecordCodecClient() as client:
            self.assertIsNone(client.pid)
            info = client.call('ping')
            self.assertFalse(info['serviceImported'])
            self.assertFalse(info['modelsImported'])
            pid = client.pid
            client.call('bind', namespace='test', schemas=[])
            original = {'status': 'ready', 'outputs': {'opponent-dora-count': {'players': [
                {'seat': 1, 'prediction': {'pointEstimate': 1.234567, 'distribution': [
                    {'value': 0, 'probability': 0}, {'value': 1, 'probability': 1},
                ]}},
            ]}}}
            encoded = client.call('encode', namespace='test', result=original)
            restored = client.call('decode', namespace='test', data=encoded['data'])
            self.assertEqual(restored, encoded['canonical'])
            self.assertEqual(restored['outputs']['opponent-dora-count']['players'][0]['prediction']['pointEstimate'], 1.235)
            second = client.call('encode', namespace='test', result=original)
            self.assertEqual(second['data'], encoded['data'])
            self.assertEqual(second['schemas'], [])
            self.assertEqual(client.pid, pid)
            process = client._process
            threads = list(client._threads)
        self.assertIsNotNone(process.poll())
        self.assertIsNone(client.pid)
        self.assertTrue(all(not thread.is_alive() for thread in threads))

    def test_job_error_does_not_restart_or_corrupt_bound_namespace(self):
        with RecordCodecClient() as client:
            client.call('bind', namespace='a', schemas=[])
            pid = client.pid
            with self.assertRaises(CodecWorkerError):
                client.call('decode', namespace='wrong', data=b'')
            self.assertEqual(client.call('ping')['pid'], pid)
            result = client.call('encode', namespace='a', result={'a': 1}, kind='decision')
            self.assertEqual(client.call('decode', namespace='a', data=result['data']), {'a': 1})

    def test_failed_encode_rolls_back_schema_namespace(self):
        with RecordCodecClient() as client:
            client.call('bind', namespace='a', schemas=[])
            with self.assertRaises(CodecWorkerError):
                client.call('encode', namespace='a', result={'outputs': {'unknown': {'bad': float('nan')}}})
            result = client.call('encode', namespace='a', result={'outputs': {'unknown': {'ok': .4}}})
            self.assertEqual(len(result['schemas']), 1)
            self.assertEqual(client.call('decode', namespace='a', data=result['data']), result['canonical'])

    def test_child_death_invalidates_channel_and_explicit_new_demand_can_restart(self):
        with RecordCodecClient(timeout=3) as client:
            client.call('ping')
            generation = client.generation
            client._process.kill()
            client._process.wait(timeout=3)
            with self.assertRaises(CodecWorkerError):
                client.call('ping')
            self.assertIsNone(client.pid)
            self.assertFalse(client.call('ping')['serviceImported'])
            self.assertGreater(client.generation, generation)

    def test_parent_eof_terminates_active_cpu_work(self):
        # The entrypoint is the same path used by the actual client and package.
        command = [sys.executable, '-u', '-m', 'rms_backend', '--record-codec-worker']
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 cwd=Path(__file__).resolve().parents[1],
                                 creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
        try:
            write_packet(child.stdin, {'id': 1, 'operation': 'bind', 'payload': {'namespace': 'slow', 'schemas': []}})
            self.assertEqual(read_packet(child.stdout)['result'], 0)
            # Large unknown container exercises CPU/schema work without a sleep
            # command or any test-only operation in the production protocol.
            large = {'outputs': {'unknown': {'values': [.123456789] * 350_000}}}
            write_packet(child.stdin, {'id': 2, 'operation': 'encode',
                                      'payload': {'namespace': 'slow', 'result': large}})
            time.sleep(.05)
            self.assertIsNone(child.poll())
            child.stdin.close()
            child.wait(timeout=3)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=3)
            for stream in (child.stdin, child.stdout, child.stderr):
                stream.close()

    def test_packet_limit_checked_before_read_and_truncation_rejected(self):
        class HeaderOnly(io.BytesIO):
            def read(self, length=-1):
                if self.tell() >= 8:
                    raise AssertionError('oversized payload read')
                return super().read(length)
        with self.assertRaisesRegex(ValueError, 'size limit'):
            read_packet(HeaderOnly(PACKET_HEADER.pack(PACKET_LIMIT + 1)))
        with self.assertRaises((ValueError, EOFError)):
            read_packet(io.BytesIO(PACKET_HEADER.pack(5) + b'x'))


if __name__ == '__main__':
    unittest.main()
