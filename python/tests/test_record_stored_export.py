from contextlib import contextmanager
from pathlib import Path
from threading import Thread
import gzip
import os
import tempfile
import unittest
from unittest.mock import patch

from rms_backend.record_analysis_refs import AnalysisReference
from rms_backend.analysis_body_codec import AnalysisBodyCodec
from rms_backend.analysis_cache_codec import AnalysisReadError
from rms_backend.record_archive import PortableBody, write_archive
from rms_backend.record_codec_scheduler import RecordCodecScheduler
from rms_backend.record_file import read_record_file
from rms_backend.record_session_storage import RecordSessionStorage, result_slot
from rms_backend.record_stored_export import StoredRecordExport
from rms_backend.record_workspace_writer import RecordWorkspaceWriter


@contextmanager
def environment():
    with tempfile.TemporaryDirectory() as directory:
        directory = Path(directory)
        writer = RecordWorkspaceWriter(directory / 'workspace.sqlite', 'export-test', create=True)
        scheduler = RecordCodecScheduler()
        storage = RecordSessionStorage('export-test', scheduler, writer)
        try:
            writer.ready.result(3)
            yield storage, scheduler, writer, directory
        finally:
            storage.stop()
            scheduler.close()
            storage.results.close()
            writer.close()


def game_and_state():
    return (dict(gameId='game', currentNodeId='A', nodes={
        'A': dict(id='A', snapshot={}, children=[], comment='before')}),
        dict(mode='research', controlledSeat=0, visibleHands=False))


class StoredRecordExportTests(unittest.TestCase):
    def test_finite_capture_contains_old_content_and_cursor_but_not_later_results(self):
        with environment() as (storage, scheduler, writer, directory):
            game, state = game_and_state()
            storage.initialize(game, state).result(3)
            identity = storage.accept_analysis(storage.reserve_analysis(), result_slot('A', 'analysisCache', 'key'),
                {'seat': 0, 'extension': [0, .25, 1]}, epoch=0, kind='decision', seat=0)
            game['nodes']['A']['analysisCache'] = {'key': AnalysisReference(storage.results, identity)}
            captured = StoredRecordExport(storage, game, state)
            game['nodes']['A']['comment'] = 'after'
            storage.accept_authored(attributes={'A': dict(id='A', children=[], comment='after')})
            storage.move_cursor({'currentNodeId': 'A', **state, 'visibleHands': True})
            newer = storage.accept_analysis(storage.reserve_analysis(), result_slot('A', 'analysisCache', 'later'),
                {'seat': 0, 'extension': [.75, .25]}, epoch=0, kind='decision', seat=0)
            game['nodes']['A']['analysisCache']['later'] = AnalysisReference(storage.results, newer)
            result = captured.write(directory / 'save.mjstudio', target=directory / 'final.mjstudio')
            self.assertLess(result['contentRevision'], storage.content_revision)
            self.assertLess(result['cursorSequence'], storage.cursor_sequence)
            loaded = read_record_file(directory / 'save.mjstudio')
            try:
                self.assertEqual(loaded['game']['nodes']['A']['comment'], 'before')
                self.assertEqual(set(loaded['game']['nodes']['A']['analysisCache']), {'key'})
                self.assertFalse(loaded['state']['visibleHands'])
                self.assertEqual(loaded['metadata']['save']['content'], result['contentRevision'])
                writer.submit('save_committed', result['saveId'], result['contentRevision'], result['cursorSequence']).result(3)
                writer.submit('save_committed', result['saveId'], result['contentRevision'], result['cursorSequence']).result(3)
                self.assertTrue(game['nodes']['A']['analysisCache']['later'])
                self.assertEqual(game['nodes']['A']['comment'], 'after')
            finally:
                loaded.origin.source._close()

    def test_failed_private_volume_cannot_exhaust_capacity_and_block_rescue_export(self):
        with environment() as (storage, scheduler, writer, directory):
            game, state = game_and_state()
            original = {f'key-{i}': dict(status='ready', extension=[0, .25, 1]) for i in range(8)}
            game['nodes']['A']['opponentAnalysisCache'] = original
            storage.initialize(game, state).result(3)
            storage.adopt_analyses(game)
            storage.wait_authored(storage.cutoff())
            submit = writer.submit
            def failed(operation, *args, **kwargs):
                if operation in ('save_intent', 'cache_body', 'store_result'):
                    raise OSError('private volume unavailable')
                return submit(operation, *args, **kwargs)
            with patch.object(writer, 'submit', side_effect=failed):
                exported, failures = [], []
                def save():
                    try:
                        exported.append(StoredRecordExport(storage, game, state).write(directory / 'rescue.mjstudio'))
                    except Exception as error:
                        failures.append(error)
                thread = Thread(target=save, daemon=True)
                thread.start()
                thread.join(10)
                self.assertFalse(thread.is_alive(), 'Save As waited for capacity retained by failed local writes')
                self.assertEqual(failures, [])
                self.assertIn('private volume', exported[0]['recoveryError'])
            loaded = read_record_file(directory / 'rescue.mjstudio')
            try:
                for key, value in original.items():
                    self.assertEqual(loaded['game']['nodes']['A']['opponentAnalysisCache'][key].resolve(), value)
                self.assertEqual(storage.results.metrics()['encodedPendingBytes'], 0)
                self.assertEqual(scheduler.metrics()['foregroundReserved'], 0)
                for key, reference in game['nodes']['A']['opponentAnalysisCache'].items():
                    storage.results.retry_persistence(reference.identity).result(3)
                    storage.results.cache.set_budget(1)
                    self.assertEqual(reference.request().result(5), original[key])
            finally:
                loaded.origin.source._close()

    def test_clearing_a_corrupt_unused_body_permits_overwrite_but_old_export_pin_still_protects_it(self):
        with environment() as (storage, scheduler, writer, directory):
            codec = AnalysisBodyCodec()
            values = [dict(status='ready', extension=[0, .25, 1]), dict(status='ready', extension=[.5, .5])]
            bodies = [PortableBody.from_bytes(gzip.compress(codec.encode(value), mtime=0)) for value in values]
            game, state = game_and_state()
            source = directory / 'original.mjstudio'
            entries = [dict(node='A', field='opponentAnalysisCache', key=f'key-{i}', body=i,
                            fields={'status': [True, 'ready'], 'extension': [False, None]}) for i in range(2)]
            write_archive(source, dict(formatVersion=3, game=game, state=state), entries, codec.schemas, bodies)
            with source.open('r+b') as file:
                file.seek(-1, os.SEEK_END)
                last = file.read(1)
                file.seek(-1, os.SEEK_END)
                file.write(bytes([last[0] ^ 1]))
            loaded = read_record_file(source)
            try:
                storage.initialize(loaded['game'], state, origin=loaded.origin).result(3)
                storage.adopt_analyses(loaded['game'])
                storage.wait_authored(storage.cutoff())
                pinned = StoredRecordExport(storage, loaded['game'], state)
                storage.clear_analysis([result_slot('A', 'opponentAnalysisCache', 'key-1')])[1].result(3)
                del loaded['game']['nodes']['A']['opponentAnalysisCache']['key-1']
                with self.assertRaises(AnalysisReadError):
                    pinned.write(directory / 'old-stage.mjstudio', target=source)
                self.assertFalse((directory / 'source.mjstudio').exists())
                result = StoredRecordExport(storage, loaded['game'], state).write(directory / 'stage.mjstudio', target=source)
                self.assertIsNone(result['recoveryError'])
                self.assertTrue((directory / 'source.mjstudio').exists())
                os.replace(directory / 'stage.mjstudio', source)
                reopened = read_record_file(source)
                try:
                    cache = reopened['game']['nodes']['A']['opponentAnalysisCache']
                    self.assertEqual(set(cache), {'key-0'})
                    self.assertEqual(cache['key-0'].resolve(), values[0])
                    reference = loaded['game']['nodes']['A']['opponentAnalysisCache']['key-0']
                    self.assertEqual(reference.request().result(5), values[0])
                finally:
                    reopened.origin.source._close()
            finally:
                loaded.origin.source._close()
