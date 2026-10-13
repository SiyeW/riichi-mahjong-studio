import gzip
import hashlib
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from threading import Thread
import unittest

from rms_backend.record_workspace import RecordWorkspace


class RecordWorkspaceTests(unittest.TestCase):
    def test_incremental_authored_and_cursor_restore_without_blob_reads(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '恢复.sqlite'
            with RecordWorkspace(path, workspace_id='test', create=True) as store:
                store.authored_delta(1, nodes={'n1': {'snapshot': {'hand': ['5mr']},
                                                     'attributes': {'children': [], 'comment': 'old'}}},
                                     metadata={'game': {'root': 'n1'}}, rounds={'r1': {'seed': 5}})
                original_snapshot = store._db.execute('SELECT snapshot FROM nodes').fetchone()[0]
                statements = []
                store._db.set_trace_callback(statements.append)
                store.authored_delta(2, attributes={'n1': {'children': [], 'comment': 'new'}})
                store.cursor(3, {'node': 'n1'})
                store.cursor(1, {'node': 'obsolete'})
                self.assertEqual(store._db.execute('SELECT snapshot FROM nodes').fetchone()[0], original_snapshot)
                self.assertFalse(any('SET snapshot' in statement for statement in statements))
                self.assertEqual(store.metadata()['cursor'], {'sequence': 3, 'state': {'node': 'n1'}})
                self.assertEqual(store.missing_coverage(2), [])
            with RecordWorkspace(path, workspace_id='test') as restored:
                index = restored.restore_index()
                self.assertEqual(index['nodes']['n1']['attributes']['comment'], 'new')
                self.assertEqual(index['nodes']['n1']['snapshot'], {'hand': ['5mr']})
                self.assertEqual(index['metadata']['cursor']['sequence'], 3)
                self.assertEqual(index['rounds']['r1'], {'seed': 5})
            with self.assertRaises(FileExistsError):
                RecordWorkspace(path, workspace_id='other', create=True)

    def test_pending_hole_and_clear_before_encode_cannot_resurrect(self):
        with tempfile.TemporaryDirectory() as directory, RecordWorkspace(
                Path(directory) / 'data', workspace_id='a', create=True) as store:
            store.accept_result(1, slot='slot', epoch=0, version='v1')
            store.authored_delta(2, metadata={'name': 'durable later edit'})
            self.assertEqual(store.missing_coverage(2), [1])
            store.clear_slots(3, [('slot', 1)])
            data = gzip.compress(b'body', mtime=0)
            body = hashlib.sha256(data).hexdigest()
            store.store_result('v1', body_id=body, codec='test', data=data,
                               schemas=[(0, {'tree': ['c', None]})])
            index = store.restore_index()
            self.assertEqual(index['slots'][0][3:], (None, None))
            self.assertEqual(store.read_body(body), data)  # Captured old export still owns it.
            self.assertEqual(store.missing_coverage(3), [])
            store.accept_result(4, slot='slot', epoch=0, version='stale')
            self.assertEqual(store.restore_index()['slots'][0][3:], (None, None))
            store.accept_result(5, slot='slot', epoch=1, version='v2')
            self.assertEqual(store.restore_index()['slots'][0][3], 'v2')

    def test_failed_body_transaction_leaves_pending_and_no_orphan_schema(self):
        with tempfile.TemporaryDirectory() as directory, RecordWorkspace(
                Path(directory) / 'data', workspace_id='a', create=True) as store:
            store.accept_result(1, slot='s', epoch=0, version='v')
            store._db.execute("CREATE TRIGGER fail_body BEFORE INSERT ON bodies BEGIN SELECT RAISE(ABORT,'simulated full disk'); END")
            data = gzip.compress(b'body')
            with self.assertRaises(sqlite3.DatabaseError):
                store.store_result('v', body_id=hashlib.sha256(data).hexdigest(), codec='test', data=data,
                                   schemas=[(0, {'test': 1})])
            self.assertEqual(store.missing_coverage(1), [1])
            self.assertEqual(store.restore_index()['schemas'], {})
            self.assertEqual(store.restore_index()['bodies'], [])

    def test_identical_body_bytes_from_different_schema_owners_do_not_conflate(self):
        with tempfile.TemporaryDirectory() as directory, RecordWorkspace(
                Path(directory) / 'data', workspace_id='a', create=True) as store:
            data = gzip.compress(b'same bytes, schema zero has different meaning')
            store.accept_result(1, slot='s1', epoch=0, version='v1')
            store.store_result('v1', body_id='body-one', namespace='schema-owner-one', codec='v2', data=data)
            store.accept_result(2, slot='s2', epoch=0, version='v2')
            with self.assertRaises(ValueError):
                store.store_result('v2', body_id='body-one', namespace='schema-owner-two', codec='v2', data=data)
            self.assertEqual(store.missing_coverage(2), [2])
            store.store_result('v2', body_id='body-two', namespace='schema-owner-two', codec='v2', data=data)
            self.assertEqual(len(store.restore_index()['bodies']), 2)

    def test_save_ack_idempotent_and_never_rewinds_current_cursor_or_newer_path(self):
        with tempfile.TemporaryDirectory() as directory, RecordWorkspace(
                Path(directory) / 'data', workspace_id='a', create=True) as store:
            store.authored_delta(1, metadata={'name': 'saved snapshot'})
            store.save_intent('first', 1, 3, 'first-target')
            store.save_intent('second', 1, 4, 'second-target')
            store.cursor(9, {'node': 'browsed while saving'})
            store.save_committed('second', 1, 4)
            store.save_committed('first', 1, 3)
            store.save_committed('second', 1, 4)
            self.assertEqual(store.metadata()['cursor']['sequence'], 9)
            self.assertEqual(store.metadata()['saved']['target'], 'second-target')
            with self.assertRaises(ValueError):
                store.save_committed('second', 2, 4)
            with self.assertRaises(ValueError):
                store.save_intent('first', 2, 3, 'wrong identity')

    def test_writer_ownership_and_logical_wal_counters(self):
        with tempfile.TemporaryDirectory() as directory, RecordWorkspace(
                Path(directory) / 'data', workspace_id='a', create=True) as store:
            errors = []
            def foreign_write():
                try: store.authored_delta(1, metadata={'bad': True})
                except Exception as error: errors.append(error)
            thread = Thread(target=foreign_write)
            thread.start(); thread.join()
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], RuntimeError)
            store.authored_delta(1, metadata={'good': True})
            maintenance = store.maintain()
            self.assertEqual(maintenance['pendingFrames'], 0)
            self.assertGreater(maintenance['allocatedBytes'], 0)
            store.retire('discarded')
            self.assertEqual(store.metadata()['disposition'], 'discarded')

    def test_process_crash_retains_commit_and_rolls_back_partial_transaction(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'data'
            code = '''
import os, sys
from rms_backend.record_workspace import RecordWorkspace
s=RecordWorkspace(sys.argv[1], workspace_id='crash', create=True)
s.authored_delta(1, metadata={'kept': 'committed'})
s._db.execute('BEGIN IMMEDIATE')
s._set('lost', 'uncommitted')
os._exit(0)
'''
            completed = subprocess.run([sys.executable, '-c', code, str(path)],
                                       cwd=Path(__file__).resolve().parents[1], capture_output=True, timeout=10)
            self.assertEqual(completed.returncode, 0, completed.stderr.decode())
            with RecordWorkspace(path, workspace_id='crash') as store:
                self.assertEqual(store.metadata()['kept'], 'committed')
                self.assertNotIn('lost', store.metadata())
                self.assertEqual(store.missing_coverage(1), [])


if __name__ == '__main__':
    unittest.main()
