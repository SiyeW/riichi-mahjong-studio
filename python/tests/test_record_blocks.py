import copy
import dataclasses
import gc
import gzip
import json
import os
import random
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from rms_backend.records.legacy_blocks import (
    MAGIC, HEADER, BlockEntry, BlockSource, open_record_source, read_block_record,
)
from tests.legacy_record_fixture import RecordFileWriter, read_record_file
from rms_backend.records.analysis_values import AnalysisReadError
from rms_backend.records.legacy_codec import pack_json
from rms_backend import service
from rms_backend.records.session import RecordSession


class CountingFile:
    def __init__(self, file):
        self.file, self.bytes = file, 0

    def read(self, count=-1):
        data = self.file.read(count)
        self.bytes += len(data)
        return data

    def __getattr__(self, name):
        return getattr(self.file, name)


class RecordBlockTests(unittest.TestCase):
    def test_pending_export_keeps_unopened_source_after_session_close(self):
        dependencies = dataclasses.replace(service.RECORD_SESSION.dependencies,
            reset_runtime=lambda: None, request_opponent_analysis=lambda: None)
        state = {'game': service.create_empty_game(123456), 'gameLoaded': True,
                 'mode': 'research', 'controlledSeat': 0, 'visibleHands': True,
                 'pendingSeatSwitch': None, 'nextGameId': 1}
        session = RecordSession(state, dependencies)
        expected = {'status': 'ready', 'outputs': {'probability': [0, .25, .75, 1]}}
        state['game']['nodes']['n_root']['opponentAnalysisCache'] = {'o5::0::public::test': expected}
        with tempfile.TemporaryDirectory() as directory:
            path, saved = Path(directory) / 'source', Path(directory) / 'saved'
            RecordFileWriter().write(path, session.serialize_prepared_export(session.prepare_export(), for_file=True))
            writer = RecordFileWriter()
            session.load(read_record_file(path, writer=writer), take_ownership=True)
            prepared = session.prepare_export()
            session.close()
            with patch.object(BlockEntry, 'result', side_effect=AssertionError('decoded while saving')):
                writer.write(saved, session.serialize_prepared_export(prepared, for_file=True))
            record = read_record_file(saved)
            self.assertEqual(copy.deepcopy(record['game']['nodes']['n_root']['opponentAnalysisCache']['o5::0::public::test']), expected)
            del record, prepared, writer
            gc.collect()

    def test_comparison_backfill_does_not_read_an_unvisited_frame(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'record'
            record = self.record(2)
            parent = record['game']['nodes']['0']
            value = parent.pop('opponentAnalysisCache')['o5::0::public::test']
            parent.update(children=['1'], snapshot={'phase': 'discard'},
                          analysisCache={'m3::0::discard::source': value})
            record['game']['currentNodeId'] = '1'
            RecordFileWriter().write(path, record)
            loaded = read_record_file(path)
            with patch.dict(service.STATE, {'game': loaded['game'], 'controlledSeat': 0}), \
                 patch.object(service.DECISION_ANALYSIS.engine_management, 'decision_source', return_value={'id': 'source'}), \
                 patch.object(BlockSource, 'read_block', side_effect=AssertionError('unvisited frame read')):
                self.assertEqual(service.DECISION_ANALYSIS.backfill_child_comparisons(loaded['game']), [])
            del loaded
            gc.collect()

    def test_same_session_reuses_new_results_and_drops_deleted_cached_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            writer, record = RecordFileWriter(), self.record()
            with patch('tests.legacy_record_fixture.pack_json', wraps=pack_json) as pack:
                writer.write(Path(directory) / 'first', record)
                self.assertEqual(pack.call_count, 3)
                writer.write(Path(directory) / 'second', record)
                self.assertEqual(pack.call_count, 3)
                del record['game']['nodes']['0']
                record['game']['nodes']['1']['opponentAnalysisCache']['o5::0::public::test'] = {'status': 'ready', 'outputs': {}}
                writer.write(Path(directory) / 'third', record)
                self.assertEqual(pack.call_count, 4)
            self.assertEqual(len(writer._block_encoded), 2)
    def test_payload_growth_does_not_make_open_read_the_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            sizes, reads = [], []
            for length in (128, 32768):
                generator = random.Random(1)
                record = self.record(2)
                for node in record['game']['nodes'].values():
                    node['opponentAnalysisCache']['o5::0::public::test']['outputs']['distribution'] = [
                        generator.random() for _ in range(length)
                    ]
                path = Path(directory) / str(length)
                RecordFileWriter().write(path, record)
                file = CountingFile(open_record_source(path))
                with patch.object(BlockSource, 'read_block', side_effect=AssertionError('eager read')):
                    loaded = read_block_record(file)
                sizes.append(path.stat().st_size)
                reads.append(file.bytes)
                del loaded
                gc.collect()
                self.assertTrue(file.closed)
            self.assertGreater(sizes[1], sizes[0] * 20)
            self.assertLess(reads[1], reads[0] * 2)

    def test_scalar_directory_matches_encoded_precision_and_endpoints(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'record'
            record = self.record(1)
            result = record['game']['nodes']['0']['opponentAnalysisCache']['o5::0::public::test']
            result.update(probability=.123456789, winProbability=1, dealInProbability=0)
            RecordFileWriter().write(path, record)
            loaded = read_record_file(path)
            result = loaded['game']['nodes']['0']['opponentAnalysisCache']['o5::0::public::test']
            self.assertEqual(result['winProbability'], 1)
            self.assertEqual(result['dealInProbability'], 0)
            self.assertAlmostEqual(result['probability'], .123456789, places=7)
            self.assertEqual(result['outputs']['distribution'], [0, .25, .75, 1])
            del result, loaded
            gc.collect()

    def test_analysis_read_failure_is_visible_without_breaking_the_record_view(self):
        with patch.object(service.OPPONENT_ANALYSIS, '_current', side_effect=AnalysisReadError('bad block')):
            result = service.OPPONENT_ANALYSIS.current()
        self.assertIn('bad block', result['status'])
        with patch.object(service.DECISION_ANALYSIS, '_get_or_schedule', side_effect=AnalysisReadError('bad block')):
            result = service.DECISION_ANALYSIS.get_or_schedule({}, {}, [])
        self.assertEqual(result['error'], 'bad block')

    def record(self, count=3):
        return {'formatVersion': 3, 'game': {'nodes': {
            str(i): {'comment': str(i), 'opponentAnalysisCache': {
                'o5::0::public::test': {'status': 'ready', 'error': None,
                                       'outputs': {'distribution': [0, .25, .75, 1], 'score': i * 1000}}
            }} for i in range(count)
        }}, 'metadata': {'source': 'test'}}

    def test_open_and_metadata_read_no_analysis_bytes_and_access_one_result_only(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'record'
            RecordFileWriter().write(path, self.record(100))
            tracked = CountingFile(open_record_source(path))
            with patch.object(BlockSource, 'read_block', side_effect=AssertionError('eager payload read')):
                record = read_block_record(tracked)
                for node in record['game']['nodes'].values():
                    self.assertEqual(node['opponentAnalysisCache']['o5::0::public::test']['status'], 'ready')
            directory_length = HEADER.unpack(path.read_bytes()[:HEADER.size])[1]
            self.assertEqual(tracked.bytes, HEADER.size + directory_length)
            with patch.object(BlockSource, 'read_block', autospec=True, wraps=BlockSource.read_block) as reads:
                # autospec wraps on descriptor methods does not bind the real
                # method; use an explicit side effect to count genuine reads.
                reads.side_effect = lambda source, item: original(source, item)
                result = record['game']['nodes']['50']['opponentAnalysisCache']['o5::0::public::test']
                self.assertEqual(result['outputs']['distribution'], [0, .25, .75, 1])
                self.assertEqual(result['outputs']['score'], 50000)
                self.assertEqual(reads.call_count, 1)
            del record, result, node, reads
            gc.collect()
            self.assertTrue(tracked.file.closed)

    def test_unvisited_blocks_save_without_decode_and_edits_clear_without_resurrection(self):
        with tempfile.TemporaryDirectory() as directory:
            original, saved = Path(directory) / 'old', Path(directory) / 'new'
            expected = self.record()
            RecordFileWriter().write(original, expected)
            record = read_record_file(original)
            record['game']['nodes']['0']['comment'] = 'edited'
            del record['game']['nodes']['1']['opponentAnalysisCache']
            record['game']['nodes']['2']['opponentAnalysisCache']['o5::0::public::test'] = {
                'status': 'ready', 'outputs': {'distribution': [1, 0, 0, 0]},
            }
            with patch.object(BlockEntry, 'result', side_effect=AssertionError('unopened block decoded')):
                RecordFileWriter().write(saved, record, recovery=True)
            actual = read_record_file(saved)
            self.assertEqual(actual['game']['nodes']['0']['comment'], 'edited')
            self.assertEqual(copy.deepcopy(actual['game']['nodes']['0']['opponentAnalysisCache']),
                             expected['game']['nodes']['0']['opponentAnalysisCache'])
            self.assertNotIn('opponentAnalysisCache', actual['game']['nodes']['1'])
            self.assertEqual(actual['game']['nodes']['2']['opponentAnalysisCache']['o5::0::public::test']['outputs'],
                             {'distribution': [1, 0, 0, 0]})
            self.assertEqual(actual['metadata']['recovery']['kind'], 'unsaved-exit')
            del actual, record
            gc.collect()

    def test_atomic_replacement_keeps_original_unopened_source_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path, staging = Path(directory) / 'record', Path(directory) / 'staging'
            RecordFileWriter().write(path, self.record())
            writer = RecordFileWriter()
            old = read_record_file(path, writer=writer)
            changed = self.record()
            changed['game']['nodes']['0']['opponentAnalysisCache']['o5::0::public::test']['outputs']['score'] = 9999
            writer.write(staging, changed)
            os.replace(staging, path)
            old_result = old['game']['nodes']['0']['opponentAnalysisCache']['o5::0::public::test']
            self.assertEqual(old_result['outputs']['score'], 0)
            current = read_record_file(path)
            self.assertEqual(current['game']['nodes']['0']['opponentAnalysisCache']['o5::0::public::test']['outputs']['score'], 9999)
            del current, old, old_result, writer
            gc.collect()

    def test_corrupt_hidden_payload_is_reported_on_access_and_cannot_be_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            path, target = Path(directory) / 'record', Path(directory) / 'target'
            RecordFileWriter().write(path, self.record())
            data = bytearray(path.read_bytes())
            data[-1] ^= 1
            path.write_bytes(data)
            record = read_record_file(path)
            hidden = record['game']['nodes']['2']['opponentAnalysisCache']['o5::0::public::test']
            with self.assertRaisesRegex(ValueError, 'Damaged analysis'):
                hidden['outputs']
            with self.assertRaisesRegex(ValueError, 'Damaged analysis'):
                RecordFileWriter().write(target, record)
            self.assertFalse(target.exists())
            self.assertFalse(hidden.entry.source.detached)  # Failed copy cannot adopt a mixed/corrupt base.
            del hidden, record
            gc.collect()

    def test_bad_directory_rejected_and_source_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'record'
            RecordFileWriter().write(path, self.record())
            data = path.read_bytes()
            length = HEADER.unpack(data[:HEADER.size])[1]
            manifest = json.loads(gzip.decompress(data[HEADER.size:HEADER.size + length]))
            manifest['entries'][1]['offset'] += 1
            encoded = gzip.compress(json.dumps(manifest).encode())
            path.write_bytes(HEADER.pack(MAGIC, len(encoded)) + encoded + data[HEADER.size + length:])
            source = open_record_source(path)
            with self.assertRaises(ValueError):
                read_block_record(source)
            self.assertTrue(source.closed)

    def test_fresh_process_reads_metadata_before_any_block_and_saves_losslessly(self):
        with tempfile.TemporaryDirectory() as directory:
            path, saved = Path(directory) / 'original', Path(directory) / 'saved'
            RecordFileWriter().write(path, self.record())
            code = '''
import sys
from unittest.mock import patch
from tests.legacy_record_fixture import read_record_file, RecordFileWriter
from rms_backend.records.legacy_blocks import BlockSource, BlockEntry
with patch.object(BlockSource, 'read_block', side_effect=AssertionError('full read')):
    record = read_record_file(sys.argv[1])
with patch.object(BlockEntry, 'result', side_effect=AssertionError('full decode')):
    RecordFileWriter().write(sys.argv[2], record)
'''
            result = subprocess.run([sys.executable, '-c', code, str(path), str(saved)],
                                    cwd=Path(__file__).resolve().parents[1],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(copy.deepcopy(read_record_file(saved))['game'], self.record()['game'])


original = BlockSource.read_block
