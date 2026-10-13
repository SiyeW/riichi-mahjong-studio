"""Actual codec child + SQLite + portable file + fresh-process reconstruction.

Storage-boundary integration, not a claim of a Studio renderer/session cutover.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Event, Thread
import unittest

from rms_backend.record_archive import PortableBody, read_archive, write_archive
from rms_backend.record_codec_client import RecordCodecClient
from rms_backend.record_workspace import RecordWorkspace


class RecordStoragePipelineTests(unittest.TestCase):
    def test_encode_once_restart_metadata_only_export_fresh_process_and_reuse(self):
        original = {'status': 'ready', 'outputs': {'opponent-score': {'players': [
            {'seat': 0, 'prediction': {'pointEstimate': 12000.49, 'distribution': [
                {'value': 1000, 'probability': .000000123456789},
                {'value': 12000, 'probability': .999999876543211},
            ]}},
        ]}}}
        record = {'formatVersion': 3, 'game': {'nodes': {'n1': {'comment': '用户评论', 'snapshot': {'dealer': 0}}}},
                  'state': {'currentNodeId': 'n1'}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace_path, exported = root / 'workspace.sqlite', root / 'portable.mjstudio'
            with RecordCodecClient() as worker, RecordWorkspace(workspace_path, workspace_id='test', create=True) as store:
                worker.call('bind', namespace='test', schemas=[])
                store.authored_delta(1, nodes={'n1': {'snapshot': {'dealer': 0}, 'attributes': {'comment': '用户评论'}}})
                store.accept_result(2, slot='slot', epoch=0, version='v1')
                encoded = worker.call('encode', namespace='test', result=original)
                digest = hashlib.sha256(encoded['data']).hexdigest()
                store.store_result('v1', body_id=digest, codec='v2', data=encoded['data'],
                                   schemas=list(enumerate(encoded['schemas'])))
                self.assertEqual(store.missing_coverage(2), [])
                canonical = encoded['canonical']
            with RecordWorkspace(workspace_path, workspace_id='test') as restored:
                # SQL authorizer fails if metadata restore attempts to fetch a BLOB.
                original_reader = restored.reader
                from contextlib import contextmanager
                @contextmanager
                def guarded_reader():
                    with original_reader() as db:
                        import sqlite3
                        db.set_authorizer(lambda action, table, column, *unused:
                            sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ and table == 'bodies' and column == 'data'
                            else sqlite3.SQLITE_OK)
                        yield db
                restored.reader = guarded_reader
                index = restored.restore_index()
                restored.reader = original_reader
                self.assertEqual(index['slots'][0][4], digest)
                schemas = [index['schemas'][i] for i in range(len(index['schemas']))]
                entries = [{'node': 'n1', 'field': 'opponentAnalysisCache', 'key': 'o5::1::public::test', 'body': 0,
                            'fields': {'status': [True, 'ready'], 'outputs': [False, None]}}]
                body = PortableBody(len(encoded['data']), bytes.fromhex(digest),
                                    lambda: iter((restored.read_body(digest),)))
                restored.save_intent('save', 2, 3, exported)
                write_archive(exported, record, entries, schemas, [body])
                restored.cursor(5, {'node': 'still-current'})
                restored.save_committed('save', 2, 3)
                self.assertEqual(restored.metadata()['cursor']['sequence'], 5)
            code = '''
import json,sys
from rms_backend.record_archive import read_archive
a=read_archive(open(sys.argv[1],'rb'))
print(json.dumps({'record':a.record,'result':a.decode_entry(0)},ensure_ascii=False))
'''
            completed = subprocess.run([sys.executable, '-c', code, str(exported)],
                                       cwd=Path(__file__).resolve().parents[1], capture_output=True, timeout=10)
            self.assertEqual(completed.returncode, 0, completed.stderr.decode())
            actual = json.loads(completed.stdout)
            self.assertEqual(actual['record'], record)
            self.assertEqual(actual['result'], canonical)

    def test_foreground_read_completes_while_writer_transaction_is_uncommitted(self):
        with tempfile.TemporaryDirectory() as directory, RecordWorkspace(
                Path(directory) / 'workspace', workspace_id='test', create=True) as store:
            store.authored_delta(1, metadata={'tag': 'old durable state'})
            done, errors = Event(), []
            def read():
                try:
                    self.assertEqual(store.metadata()['tag'], 'old durable state')
                except Exception as error:
                    errors.append(error)
                finally:
                    done.set()
            with store.transaction():
                store._set('tag', 'not committed yet')
                thread = Thread(target=read)
                thread.start()
                self.assertTrue(done.wait(2), 'foreground read waited for the write transaction')
                thread.join()
                self.assertEqual(errors, [])
            self.assertEqual(store.metadata()['tag'], 'not committed yet')

    def test_local_backing_failure_does_not_prevent_independent_rescue_export(self):
        with tempfile.TemporaryDirectory() as directory, RecordCodecClient() as worker, RecordWorkspace(
                Path(directory) / 'workspace', workspace_id='test', create=True) as store:
            worker.call('bind', namespace='test', schemas=[])
            store.accept_result(1, slot='s', epoch=0, version='v1')
            encoded = worker.call('encode', namespace='test', result={'status': 'ready', 'outputs': {}})
            store._db.execute('PRAGMA query_only=ON')
            with self.assertRaises(Exception):
                store.store_result('v1', body_id=hashlib.sha256(encoded['data']).hexdigest(), codec='v2', data=encoded['data'])
            target = Path(directory) / 'healthy-destination.mjstudio'
            write_archive(target, {'game': {'nodes': {'n': {}}}},
                          [{'node': 'n', 'field': 'opponentAnalysisCache', 'key': 'key', 'body': 0,
                            'fields': {'status': [True, 'ready'], 'outputs': [False, None]}}],
                          encoded['schemas'], [PortableBody.from_bytes(encoded['data'])])
            archive = read_archive(target.open('rb'))
            self.assertEqual(archive.decode_entry(0), encoded['canonical'])
            self.assertEqual(store.missing_coverage(1), [1])
            del archive


if __name__ == '__main__':
    unittest.main()
