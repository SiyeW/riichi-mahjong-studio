from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from rms_backend.records.workspace_lease import WorkspaceLease
from rms_backend.records.workspace_writer import RecordWorkspaceWriter
from rms_backend.records.workspace import RecordWorkspace


class RecordWorkspaceWriterTests(unittest.TestCase):
    def test_authored_and_imported_input_bytes_trigger_off_lock_maintenance(self):
        with tempfile.TemporaryDirectory() as directory:
            actual = RecordWorkspace.maintain
            with patch.object(RecordWorkspace, 'maintain', autospec=True, side_effect=actual) as maintain:
                writer = RecordWorkspaceWriter(Path(directory) / 'workspace.sqlite', 'test', create=True)
                try:
                    writer.ready.result(3)
                    text = 'x' * (4 * 1024 * 1024)
                    writer.submit('authored_delta', 1, metadata={'game:comment': text}).result(5)
                    writer.submit('metadata').result(5)  # Drain maintenance after the write's durable receipt.
                    self.assertEqual(maintain.call_count, 1)
                    writer.submit('adopt_sources', [dict(version='input', slot='slot', epoch=0,
                        summary={'input': True}, input={'extension': text})]).result(5)
                    writer.submit('metadata').result(5)
                    self.assertEqual(maintain.call_count, 2)
                    metrics = writer.metrics()['wal']
                    self.assertIn('pendingFrames', metrics)
                    self.assertGreaterEqual(metrics['allocatedBytes'], metrics['pendingFrames'])
                finally:
                    writer.close()

    def test_live_writer_lease_rejects_a_second_owner_and_releases_after_close(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'workspace.sqlite'
            first = RecordWorkspaceWriter(path, 'test', create=True)
            first.ready.result(3)
            second = RecordWorkspaceWriter(path, 'test')
            try:
                with self.assertRaises(OSError):
                    second.ready.result(3)
            finally:
                second.close()
                first.close()
            third = RecordWorkspaceWriter(path, 'test')
            try:
                third.ready.result(3)
                third.submit('authored_delta', 1, metadata={'title': 'reopened'}).result(3)
            finally:
                third.close()

    def test_crashed_process_releases_os_lease_without_deleting_lock_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'owner.lock'
            code = ('import os,sys; from rms_backend.records.workspace_lease import WorkspaceLease; '
                    'lease=WorkspaceLease(sys.argv[1],"test"); print("locked",flush=True); os._exit(0)')
            result = subprocess.run([sys.executable, '-c', code, str(path)],
                                    cwd=Path(__file__).resolve().parents[1],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'locked')
            with WorkspaceLease(path, 'test'):
                self.assertTrue(path.exists())
            with self.assertRaisesRegex(ValueError, 'identity'):
                WorkspaceLease(path, 'another-workspace')
