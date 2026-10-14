from contextlib import contextmanager
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from dataclasses import replace
import gzip

from rms_backend.record_codec_scheduler import RecordCodecScheduler
from rms_backend.record_session_storage import RecordSessionStorage, result_slot
from rms_backend.record_workspace_writer import RecordWorkspaceWriter
from rms_backend.record_file import RecordFileWriter, read_record_file
from rms_backend.record_session import RecordSession
from rms_backend.record_blocks import BlockSource
from rms_backend.record_analysis_refs import AnalysisReference
from rms_backend.analysis_body_codec import AnalysisBodyCodec
from rms_backend.record_archive import ArchiveSource, PortableBody, write_archive


@contextmanager
def session_storage():
    with tempfile.TemporaryDirectory() as directory:
        writer = RecordWorkspaceWriter(Path(directory) / 'workspace.sqlite', 'session', create=True)
        scheduler = RecordCodecScheduler()
        session = RecordSessionStorage('session', scheduler, writer, coalesce_seconds=10)
        try:
            writer.ready.result(3)
            game = {'gameId': 'test', 'currentNodeId': 'n', 'nodes': {
                'n': {'snapshot': {'hand': ['5mr'], 'history': []}, 'children': [], 'comment': 'old'}},
                'rootNodeId': 'n'}
            session.initialize(game, {'controlledSeat': 0, 'mode': 'research'}).result(3)
            yield session, writer, scheduler
        finally:
            session.stop()
            scheduler.close()
            writer.close()


class RecordSessionStorageTests(unittest.TestCase):
    def test_unvisited_legacy_sources_restore_from_spans_or_the_persisted_locator(self):
        for compressed in (False, True):
            with self.subTest(compressed=compressed), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / 'legacy.mjstudio'
                key = 'o5::0::public::test'
                expected = {'status': 'ready', 'outputs': {'extension': [0, .25, 1]}}
                document = {'formatVersion': 3, 'game': {'currentNodeId': 'n', 'nodes': {
                    'n': {'snapshot': {'hand': ['1m']}, 'children': [],
                          'opponentAnalysisCache': {key: expected}}}}, 'state': {'controlledSeat': 0}}
                RecordFileWriter().write(source, document, compressed=compressed)
                loaded = read_record_file(source)
                writer = RecordWorkspaceWriter(Path(directory) / 'workspace.sqlite', 'legacy', create=True)
                scheduler = RecordCodecScheduler()
                storage = RecordSessionStorage('legacy', scheduler, writer)
                try:
                    storage.initialize(loaded['game'], loaded['state'], origin=loaded.origin).result(3)
                    storage.adopt_analyses(loaded['game'])
                    storage.wait_authored(storage.cutoff())
                    self.assertIsNone(scheduler.client.pid)
                    slot = result_slot('n', 'opponentAnalysisCache', key)
                    identity = storage.results.slot(slot)
                    storage.stop()
                    scheduler.close()
                    writer.close()
                    loaded.origin.source._close()
                    next_writer = RecordWorkspaceWriter(writer.path, 'legacy')
                    next_scheduler = RecordCodecScheduler()
                    try:
                        restored, game, _ = RecordSessionStorage.restore('legacy', next_scheduler, next_writer)
                        self.assertIsNone(restored.source_error)
                        self.assertIsNone(next_scheduler.client.pid)
                        self.assertEqual(restored.results.slot(slot), identity)
                        reference = game['nodes']['n']['opponentAnalysisCache'][key]
                        reference.request().result(5)
                        restored.results._versions[identity].durable.result(3)
                        self.assertEqual(reference.ready_value(), expected)
                        self.assertEqual(restored.content_revision, storage.content_revision)
                        restored.stop()
                    finally:
                        next_scheduler.close()
                        next_writer.close()
                finally:
                    storage.stop()
                    scheduler.close()
                    writer.close()
                    loaded.origin.source._close()

    def test_v2_source_adoption_and_restore_reuse_encoded_bytes_without_reencoding(self):
        with tempfile.TemporaryDirectory() as directory:
            codec = AnalysisBodyCodec()
            original = {'status': 'ready', 'outputs': {'opponent-dora-count': {'players': [
                {'seat': 3, 'prediction': {'expectedValue': 1.23456,
                    'distribution': [{'value': 0, 'probability': 0}, {'value': 1, 'probability': 1}]}}]}}}
            raw = codec.encode(original)
            canonical = codec.decode(raw)
            encoded = gzip.compress(raw, compresslevel=3, mtime=0)
            key = 'o5::0::public::test'
            source = Path(directory) / 'v2.mjstudio'
            document = {'formatVersion': 3, 'game': {'currentNodeId': 'n', 'nodes': {
                'n': {'snapshot': {'hand': ['1m']}, 'children': []}}}, 'state': {'controlledSeat': 0}}
            entries = [{'node': 'n', 'field': 'opponentAnalysisCache', 'key': key,
                        'body': 0, 'fields': {'status': [True, 'ready'], 'outputs': [False, None]}}]
            write_archive(source, document, entries, codec.schemas, [PortableBody.from_bytes(encoded)])
            writer = RecordWorkspaceWriter(Path(directory) / 'workspace.sqlite', 'native', create=True)
            scheduler = RecordCodecScheduler()
            storage = RecordSessionStorage('native', scheduler, writer)
            loaded = None
            try:
                with patch.object(ArchiveSource, 'read_body', side_effect=AssertionError('Eager native body read')):
                    loaded = read_record_file(source)
                    storage.initialize(loaded['game'], loaded['state'], origin=loaded.origin).result(3)
                    storage.adopt_analyses(loaded['game'])
                storage.wait_authored(storage.cutoff())
                self.assertIsNone(scheduler.client.pid)
                reference = loaded['game']['nodes']['n']['opponentAnalysisCache'][key]
                slot = result_slot('n', 'opponentAnalysisCache', key)
                identity = reference.identity
                with patch.object(scheduler, 'codec', wraps=scheduler.codec) as cpu:
                    reference.request().result(5)
                    self.assertEqual([call.args[2] for call in cpu.call_args_list], ['read'])
                self.assertEqual(reference.ready_value(), canonical)
                with storage.results.capture() as versions:
                    self.assertEqual(b''.join(storage.results.portable(versions[0]).chunks()), encoded)
                with writer.ready.result().reader() as reader:
                    self.assertEqual(reader.execute('SELECT count(*) FROM bodies WHERE data IS NOT NULL').fetchone()[0], 0)
                storage.stop()
                scheduler.close()
                writer.close()
                loaded.origin.source._close()
                next_writer = RecordWorkspaceWriter(Path(directory) / 'workspace.sqlite', 'native')
                next_scheduler = RecordCodecScheduler()
                try:
                    with patch('rms_backend.record_file.read_record_file', side_effect=AssertionError('Native restore reparsed source')):
                        restored, game, _state = RecordSessionStorage.restore('native', next_scheduler, next_writer)
                    self.assertIsNone(next_scheduler.client.pid)
                    self.assertEqual(restored.results.slot(slot), identity)
                    next_reference = game['nodes']['n']['opponentAnalysisCache'][key]
                    with patch.object(next_scheduler, 'codec', wraps=next_scheduler.codec) as cpu:
                        next_reference.request().result(5)
                        self.assertEqual([call.args[2] for call in cpu.call_args_list], ['read'])
                    self.assertEqual(next_reference.ready_value(), canonical)
                    restored.stop()
                finally:
                    next_scheduler.close()
                    next_writer.close()
            finally:
                storage.stop()
                scheduler.close()
                writer.close()
                if loaded is not None:
                    loaded.origin.source._close()

    def test_record_session_adopts_unopened_native_results_without_parent_body_reads(self):
        from rms_backend import service
        with tempfile.TemporaryDirectory() as directory:
            writer = RecordWorkspaceWriter(Path(directory) / 'workspace.sqlite', 'candidate', create=True)
            scheduler = RecordCodecScheduler()
            storage = RecordSessionStorage('candidate', scheduler, writer)
            legacy_writer = RecordFileWriter()
            try:
                def factory(game, state, *, origin=None):
                    storage.initialize(game, state, origin=origin).result(3)
                    return storage
                state = {'game': None, 'gameLoaded': False, 'mode': 'play', 'controlledSeat': 0,
                         'visibleHands': False, 'pendingSeatSwitch': None, 'nextGameId': 1}
                dependencies = replace(service.RECORD_SESSION.dependencies,
                    reset_runtime=lambda: None, request_opponent_analysis=lambda *a: None,
                    backfill_child_comparisons=lambda game: [])
                session = RecordSession(state, dependencies, storage_factory=factory)
                game = service.create_empty_game(123456)
                original = {'status': 'ready', 'outputs': {'extension': [0, .25, 1]}}
                key = 'o5::0::public::test'
                game['nodes']['n_root']['opponentAnalysisCache'] = {key: original}
                source = Path(directory) / 'source.mjstudio'
                RecordFileWriter().write(source, {'formatVersion': 2, 'game': game,
                                                  'state': {'controlledSeat': 0, 'mode': 'research'}})
                record = read_record_file(source, writer=legacy_writer)
                raw = record['game']['nodes']['n_root']['opponentAnalysisCache'][key]
                with patch.object(BlockSource, 'read_block', side_effect=AssertionError('Adoption loaded a saved body')):
                    session.load(record, take_ownership=True, file_writer=legacy_writer)
                self.assertIs(session.storage, storage)
                reference = state['game']['nodes']['n_root']['opponentAnalysisCache'][key]
                self.assertIsInstance(reference, AnalysisReference)
                self.assertIsNone(scheduler.client.pid)
                reference.request().result(5)
                storage.results._versions[reference.identity].durable.result(3)
                self.assertEqual(reference.ready_value(), original)
                self.assertIsNone(raw.entry._result)
                session.close()
                self.assertIsNone(session.storage)
            finally:
                storage.stop()
                scheduler.close()
                writer.close()
                if legacy_writer._block_source is not None:
                    legacy_writer._block_source._close()

    def test_comment_packets_are_coalesced_without_rewriting_snapshots(self):
        with session_storage() as (session, writer, _):
            workspace = writer.ready.result()
            before = workspace.restore_index()['nodes']['n']['snapshot']
            revision, first = session.accept_authored(attributes={'n': {'children': [], 'comment': 'first'}})
            deadline = session._timer
            _, second = session.accept_authored(attributes={'n': {'children': [], 'comment': 'second'}})
            self.assertIs(session._timer, deadline)
            self.assertFalse(first.cancel())
            self.assertEqual(workspace.restore_index()['nodes']['n']['attributes']['comment'], 'old')
            cutoff = session.cutoff()
            session.wait_authored(cutoff)
            index = workspace.restore_index()
            self.assertEqual(index['nodes']['n']['snapshot'], before)
            self.assertEqual(index['nodes']['n']['attributes']['comment'], 'second')
            self.assertTrue(first.done() and second.done())
            self.assertEqual(workspace.missing_coverage(cutoff.content), [])

    def test_freeze_rejects_inflight_old_results_even_after_cancel_and_resume(self):
        with session_storage() as (session, _writer, _):
            old = session.reserve_analysis()
            close = session.cutoff(freeze=True)
            self.assertIsNone(session.reserve_analysis())
            self.assertTrue(session.cancel_close(close))
            self.assertFalse(session.cancel_close(close))
            self.assertIsNone(session.accept_analysis(old, 'slot', {'probability': .25}, epoch=0, kind='decision'))
            self.assertEqual(session.content_revision, 1)
            new = session.reserve_analysis()
            slot = result_slot('n', 'analysisCache', 'decision-test')
            identity = session.accept_analysis(new, slot, {'probability': .5}, epoch=0, kind='decision')
            self.assertEqual(session.content_revision, 2)
            with session.results.capture() as versions:
                session.results.portable(versions[0])
                versions[0].durable.result(3)
            self.assertEqual(session.results.slot(slot), identity)

    def test_content_and_cursor_are_independent_and_old_barrier_never_waits_for_new_cursor(self):
        with session_storage() as (session, writer, _):
            workspace = writer.ready.result()
            session.move_cursor({'currentNodeId': 'earlier'})
            cutoff = session.cutoff()
            started, release = threading.Event(), threading.Event()
            original = workspace.cursor
            def held(sequence, state):
                if sequence == cutoff.cursor + 1:
                    started.set()
                    release.wait(3)
                return original(sequence, state)
            workspace.cursor = held
            try:
                session.move_cursor({'currentNodeId': 'later'})
                self.assertTrue(started.wait(2))
                session.wait_authored(cutoff)
                self.assertEqual(session.content_revision, cutoff.content)
                self.assertEqual(session.cursor_sequence, cutoff.cursor + 1)
            finally:
                release.set()
            session.wait_authored(session.cutoff())
            self.assertEqual(workspace.metadata()['cursor']['state']['currentNodeId'], 'later')

    def test_authored_failure_retains_changed_packets_for_explicit_retry(self):
        with session_storage() as (session, writer, _):
            workspace = writer.ready.result()
            original = workspace.authored_batch
            def failed(_changes):
                raise OSError('Injected durable write failure')
            workspace.authored_batch = failed
            _, pending = session.accept_authored(attributes={'n': {'comment': 'must survive', 'children': []}})
            session.flush_authored()
            with self.assertRaisesRegex(OSError, 'failure'):
                pending.result(3)
            self.assertIsNone(session.reserve_analysis())
            workspace.authored_batch = original
            for future in session.retry_authored():
                future.result(3)
            session.wait_authored(session.cutoff())
            self.assertEqual(workspace.restore_index()['nodes']['n']['attributes']['comment'], 'must survive')

    def test_uncertain_receipt_retry_does_not_reapply_an_old_comment_over_a_newer_one(self):
        with session_storage() as (session, writer, _):
            workspace = writer.ready.result()
            original = workspace.authored_batch
            def uncertain(changes):
                original(changes)
                raise OSError('Injected missing commit receipt')
            workspace.authored_batch = uncertain
            _, old = session.accept_authored(attributes={'n': {'comment': 'old edit', 'children': []}})
            session.flush_authored()
            with self.assertRaises(OSError):
                old.result(3)
            workspace.authored_batch = original
            session.accept_authored(attributes={'n': {'comment': 'new edit', 'children': []}})
            session.flush_authored()
            for future in session.retry_authored():
                future.result(3)
            session.wait_authored(session.cutoff())
            self.assertEqual(workspace.restore_index()['nodes']['n']['attributes']['comment'], 'new edit')

    def test_session_restore_preserves_authored_state_and_lazy_analysis_without_rule_replay(self):
        with session_storage() as (session, writer, scheduler):
            session.accept_authored(attributes={'n': {'children': ['branch'], 'comment': 'edited'}}, nodes={
                'branch': {'snapshot': {'hand': ['7p'], 'history': ['accepted action']},
                           'attributes': {'children': [], 'parentId': 'n', 'comment': 'branch note'}}})
            session.move_cursor({'currentNodeId': 'branch', 'controlledSeat': 2, 'mode': 'research'})
            admission = session.reserve_analysis()
            slot = result_slot('branch', 'analysisCache', 'decision-test')
            identity = session.accept_analysis(admission, slot, {'probability': .75},
                                               epoch=0, kind='decision', seat=2)
            cutoff = session.cutoff(freeze=True)
            session.wait_authored(cutoff)
            with session.results.capture() as versions:
                session.results.portable(versions[0])
                versions[0].durable.result(3)
            session.stop()
            scheduler.close()
            writer.close()
            next_writer = RecordWorkspaceWriter(writer.path, 'session')
            next_scheduler = RecordCodecScheduler()
            try:
                restored, game, state = RecordSessionStorage.restore('session', next_scheduler, next_writer)
                self.assertNotEqual(restored.session_id, session.session_id)
                self.assertEqual(restored.content_revision, cutoff.content)
                self.assertEqual(game['currentNodeId'], 'branch')
                self.assertEqual(game['nodes']['n']['comment'], 'edited')
                self.assertEqual(game['nodes']['branch']['snapshot']['history'], ['accepted action'])
                self.assertEqual(state['controlledSeat'], 2)
                self.assertIsNone(next_scheduler.client.pid)
                self.assertEqual(restored.results.slot(slot), identity)
                restored.results.request(identity).result(5)
                self.assertEqual(restored.results.hot(identity), {'probability': .75})
                restored.stop()
            finally:
                next_scheduler.close()
                next_writer.close()
