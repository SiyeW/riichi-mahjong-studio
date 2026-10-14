from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from rms_backend.record_workspace_lease import WorkspaceLease
from rms_backend.record_workspace_writer import RecordWorkspaceWriter


class RecordWorkspaceWriterTests(unittest.TestCase):
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
            code = ('import os,sys; from rms_backend.record_workspace_lease import WorkspaceLease; '
                    'lease=WorkspaceLease(sys.argv[1],"test"); print("locked",flush=True); os._exit(0)')
            result = subprocess.run([sys.executable, '-c', code, str(path)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'locked')
            with WorkspaceLease(path, 'test'):
                self.assertTrue(path.exists())
            with self.assertRaisesRegex(ValueError, 'identity'):
                WorkspaceLease(path, 'another-workspace')
