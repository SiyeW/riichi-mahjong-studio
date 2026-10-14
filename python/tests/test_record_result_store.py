from contextlib import contextmanager
from pathlib import Path
import os
import tempfile
import threading
import unittest

from rms_backend.analysis_cache_codec import index_json_array, pack_json
from rms_backend.record_archive import read_archive, write_archive
from rms_backend.record_codec_packets import result_packet, materialize_packet
from rms_backend.record_codec_scheduler import RecordCodecScheduler
from rms_backend.record_codec_client import RecordCodecClient
from rms_backend.record_result_store import RecordResultStore
from rms_backend.record_workspace_writer import RecordWorkspaceWriter


@contextmanager
def storage(budget=1024 * 1024, *, client=None):
    with tempfile.TemporaryDirectory() as directory:
        writer = RecordWorkspaceWriter(Path(directory) / 'workspace.sqlite', 'test', create=True)
        lane = RecordCodecScheduler(client=client)
        store = RecordResultStore('test', lane, writer, budget=budget)
        try:
            writer.ready.result(3)
            yield store, writer, lane, Path(directory)
        finally:
            store.close()
            lane.close()
            writer.close()


class RecordResultStoreTests(unittest.TestCase):
    def test_reclamation_respects_export_pins_then_removes_obsolete_versions_and_bodies(self):
        with storage() as (store, writer, lane, directory):
            identity = store.accept('slot', {'status': 'ready', 'extension': [.25, .75]}, revision=1,
                                    epoch=0, reservation=store.reserve())
            with store.capture() as versions:
                store.portable(versions[0])
                versions[0].durable.result(3)
                store.clear(['slot'], revision=2).result(3)
                self.assertIsNone(store.collect_garbage())
                self.assertEqual(store.metrics()['versions'], 1)
                body = store.portable(versions[0])
                self.assertGreater(len(b''.join(body.chunks())), 0)
            store.collect_garbage().result(3)
            self.assertEqual(store.metrics()['versions'], 0)
            with writer.ready.result().reader() as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM versions').fetchone()[0], 0)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM bodies').fetchone()[0], 0)

    @unittest.skipUnless(os.environ.get('RMS_TEST_CODEC_EXECUTABLE'), 'No isolated frozen helper specified')
    def test_frozen_worker_integrates_owned_version_store_and_private_database(self):
        client = RecordCodecClient(command=[os.environ['RMS_TEST_CODEC_EXECUTABLE'], '--record-codec-worker'])
        with storage(client=client) as (store, writer, _lane, directory):
            identity = store.accept('slot', {'outputs': {'extension': [0, .25, 1]}}, revision=1,
                                    epoch=0, reservation=store.reserve(), kind='decision')
            with store.capture() as versions:
                body = store.portable(versions[0])
                versions[0].durable.result(5)
                info = client.call('ping')
                self.assertFalse(info['serviceImported'])
                self.assertFalse(info['modelsImported'])
                self.assertGreaterEqual(tuple(map(int, info['sqliteVersion'].split('.'))), (3, 51, 3))
                record = {'formatVersion': 3, 'game': {'nodes': {'n': {'snapshot': {}}}}}
                entries = [{'node': 'n', 'field': 'analysisCache', 'key': 'test',
                            'body': 0, 'fields': versions[0].fields}]
                target = directory / 'packaged.mjstudio'
                write_archive(target, record, entries, store.schemas, [body])
                archive = read_archive(open(target, 'rb'))
                self.assertEqual(archive.decode_entry(0), store.hot(identity))
                archive.source._close()
                self.assertEqual(writer.ready.result().missing_coverage(1), [])
        self.assertIsNone(client.pid)

    def test_legacy_fragments_transfer_without_decoding_in_parent(self):
        result = {'status': 'ready', 'outputs': {'unknown': {'tiles': [0, .123456789, 1]}}}
        packed = pack_json([result], indexed=True)
        legacy = index_json_array(packed)[0]
        self.assertEqual(legacy._resolved, {})
        packet = result_packet(legacy)
        self.assertEqual(legacy._resolved, {})
        self.assertEqual(materialize_packet(packet), result)

    def test_changed_legacy_header_retains_unopened_original_fields(self):
        from rms_backend.record_file import RecordFileWriter, read_record_file
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'old.mjstudio'
            original = {'status': 'ready', 'outputs': {'extension': [0, .5, 1]}}
            record = {'game': {'nodes': {'n': {'opponentAnalysisCache': {'key': original}}}}}
            writer = RecordFileWriter()
            writer.write(path, record)
            loaded = read_record_file(path, writer=writer)
            value = loaded['game']['nodes']['n']['opponentAnalysisCache']['key']
            value['status'] = 'old'
            packet = result_packet(value)
            self.assertIsNone(value.entry._result)
            self.assertEqual(materialize_packet(packet), {**original, 'status': 'old'})
            value.entry.source._close()

    def test_demanded_legacy_conversion_once_and_repeated_portable_save(self):
        with storage() as (store, writer, lane, directory):
            original = {'status': 'ready', 'outputs': {'extension': {'value': .123456789}}}
            legacy = index_json_array(pack_json([original], indexed=True))[0]
            identity = store.register('node/opponent/0', fields={'status': [True, 'ready'],
                                      'outputs': [False, None]}, raw=legacy)
            self.assertIsNone(lane.client.pid)
            pending = store.request(identity)
            pending.result(5)
            self.assertEqual(store.hot(identity), original)
            version = store._versions[identity]
            version.durable.result(3)
            self.assertIsNone(version.raw)
            self.assertIsNone(version.encoded)
            self.assertEqual(store.metrics()['encodedPendingBytes'], 0)
            self.assertEqual(writer.ready.result().missing_coverage(100), [])
            with store.capture() as captured:
                body = store.portable(captured[0])
                record = {'formatVersion': 3, 'game': {'nodes': {'n': {'snapshot': {}}}}}
                entries = [{'node': 'n', 'field': 'opponentAnalysisCache', 'key': 'k',
                            'body': 0, 'fields': version.fields}]
                target = directory / 'one.mjstudio'
                write_archive(target, record, entries, store.schemas, [body])
                archive = read_archive(open(target, 'rb'))
                self.assertEqual(archive.decode_entry(0), original)
                archive.source._close()
                second = directory / 'two.mjstudio'
                write_archive(second, record, entries, store.schemas, [body])
                self.assertEqual(target.read_bytes(), second.read_bytes())
            store.cache.set_budget(1)
            self.assertIsNone(store.hot(identity))
            store.cache.set_budget(1024 * 1024)
            store.request(identity).result(5)
            self.assertEqual(store.hot(identity), original)

    def test_clear_during_encode_keeps_old_snapshot_without_republishing(self):
        with storage() as (store, writer, lane, _):
            started, release = threading.Event(), threading.Event()
            active = lane.submit_read('held', lambda _: (started.set(), release.wait(3)))
            self.assertTrue(started.wait(2))
            reservation = store.reserve()
            identity = store.accept('slot', {'probability': .25}, revision=1, epoch=0,
                                    reservation=reservation, kind='decision')
            with store.capture() as captured:
                store.clear(['slot'], revision=2).result(3)
                self.assertIsNone(store.slot('slot'))
                release.set()
                active.result(2)
                store.portable(captured[0])
                captured[0].durable.result(3)
                self.assertIsNone(store.slot('slot'))
                self.assertEqual(writer.ready.result().missing_coverage(2), [])
                self.assertEqual(writer.ready.result().restore_index()['slots'][0][3], None)
                self.assertIsNone(store.accept('slot', {'probability': .5}, revision=3, epoch=0,
                                              reservation=store.reserve(), kind='decision'))

    def test_slow_durable_writer_does_not_block_demanded_codec_jobs(self):
        with storage() as (store, writer, lane, _):
            workspace = writer.ready.result()
            started, release = threading.Event(), threading.Event()
            original = workspace.store_result
            def held(*args, **kwargs):
                started.set()
                release.wait(3)
                return original(*args, **kwargs)
            workspace.store_result = held
            try:
                identity = store.accept('slot', {'probability': .25}, revision=1, epoch=0,
                                        reservation=store.reserve(), kind='decision')
                store._versions[identity].pending.result(5)
                self.assertTrue(started.wait(2))
                completed = lane.submit_read('other', lambda _: 'ready').result(1)
                self.assertEqual(completed, 'ready')
                self.assertEqual(lane.metrics()['backgroundReserved'], 1)
                self.assertGreater(store.metrics()['encodedPendingBytes'], 0)
            finally:
                release.set()
            store._versions[identity].durable.result(3)
            self.assertEqual(lane.metrics()['backgroundReserved'], 0)

    def test_write_failure_retains_rescue_bytes_and_retry_owns_schema_delta(self):
        with storage() as (store, writer, lane, _):
            workspace = writer.ready.result()
            original = workspace.store_result
            def failed(*_args, **_kwargs):
                raise OSError('Injected destination is full')
            workspace.store_result = failed
            identity = store.accept('slot', {'outputs': {'extension': [1, 0]}},
                                    revision=1, epoch=0, reservation=store.reserve())
            version = store._versions[identity]
            version.pending.result(5)
            with self.assertRaisesRegex(OSError, 'full'):
                version.durable.result(3)
            self.assertIsNotNone(version.encoded)
            self.assertIsNone(store.reserve())
            self.assertEqual(b''.join(store.portable(version).chunks()), version.encoded)
            workspace.store_result = original
            store.retry_persistence(identity).result(3)
            self.assertIsNone(version.encoded)
            self.assertEqual(lane.metrics()['backgroundReserved'], 0)

    def test_captured_legacy_export_survives_active_record_close(self):
        with storage() as (store, writer, _lane, _directory):
            identity = store.register('legacy', fields={'value': [True, .25]},
                                      raw={'value': .25}, kind='decision')
            with store.capture() as versions:
                store.close()
                body = store.portable(versions[0])
                self.assertGreater(body.length, 0)
                versions[0].durable.result(3)
            self.assertIsNone(store._versions[identity].encoded)

    def test_private_restore_is_indexed_and_defers_the_first_body_read(self):
        with storage() as (store, writer, lane, directory):
            result = {'probability': .25, 'entries': [{'tile': '5mr', 'probability': .75}]}
            identity = store.accept('n/decision/0', result, revision=1, epoch=0,
                                    reservation=store.reserve(), kind='decision', seat=0)
            with store.capture() as versions:
                store.portable(versions[0])
                versions[0].durable.result(3)
            store.close()
            writer.close()
            restored_writer = RecordWorkspaceWriter(directory / 'workspace.sqlite', 'test')
            try:
                workspace = restored_writer.ready.result(3)
                original = workspace.read_body
                def unexpected(_key):
                    self.fail('Restore eagerly read an analysis body')
                workspace.read_body = unexpected
                restored = RecordResultStore.restore('test', lane, restored_writer)
                self.assertEqual(restored.slot('n/decision/0'), identity)
                self.assertIsNone(restored.hot(identity))
                workspace.read_body = original
                restored.request(identity).result(5)
                self.assertEqual(restored.hot(identity), result)
                restored.close()
            finally:
                restored_writer.close()

    def test_worker_death_requires_explicit_retry_and_rebinds_schema_namespace(self):
        with storage() as (store, writer, lane, _directory):
            identity = store.register('source', fields={'value': [True, .25]},
                                      raw={'value': .25}, kind='decision')
            with store.capture() as versions:
                store.portable(versions[0])
                versions[0].durable.result(3)
            store.cache.set_budget(1)
            store.cache.set_budget(1024 * 1024)
            child = lane.client._process
            child.kill()
            child.wait(timeout=3)
            future = store.request(identity)
            with self.assertRaises(Exception):
                future.result(3)
            with self.assertRaises(Exception):
                store.request(identity)
            store.request(identity, retry=True).result(5)
            self.assertEqual(store.hot(identity), {'value': .25})
            self.assertNotEqual(lane.client.pid, child.pid)
