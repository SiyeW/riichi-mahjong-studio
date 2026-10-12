import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from rms_backend.analysis_cache_codec import (
    PackedJsonIndex, _TokenCursor, index_json_array, json_string_seed, pack_json, unpack_json,
)
from rms_backend.analysis_cache_index import attach_index
from rms_backend.analysis_cache_storage import (
    AnalysisCachePacker, compact_record_analysis_caches, expand_record_analysis_caches,
)
from rms_backend.record_file import RecordFileWriter, read_record_file
from rms_backend.record_session import RecordSession


class PersistedAnalysisIndexTests(unittest.TestCase):
    def values(self):
        return [{f'模型-{i}': {'status': 'ready', 'probability': [0, .25, .75, 1],
                            'outputs': {'items': [False, True, None, '和牌', {'score': 12000}]}}}
                for i in range(4)]

    def read_without_scan(self, packed):
        with patch.object(_TokenCursor, 'scan', side_effect=AssertionError('whole-cache scan')):
            return index_json_array(packed)

    def test_generated_index_reads_metadata_without_scan(self):
        expected = self.values()
        packed = pack_json(expected, indexed=True)
        self.assertEqual(unpack_json(packed), expected)
        values = self.read_without_scan(packed)
        self.assertEqual(values[0]['模型-0']['status'], 'ready')
        self.assertEqual(values[0]['模型-0']['probability'], [0, .25, .75, 1])
        self.assertEqual(copy.deepcopy(values), expected)

    def test_mixed_arrays_empty_objects_and_multibyte_keys(self):
        expected = [{f'key-{i}': [0, i, {'x': [1, 0]}, '字'] for i in range(260)},
                    {}, [], [None, {'nested': True}], None, 'end', 0]
        for indexed in (False, True):
            packed = pack_json(expected, indexed=indexed)
            if not indexed:
                index_json_array(packed)
            self.assertEqual(copy.deepcopy(self.read_without_scan(packed)), expected)

    def test_legacy_conversion_and_changed_fragments_rebase_without_vector_decode(self):
        expected = self.values()
        packed = pack_json(expected)
        source = PackedJsonIndex(packed)
        values = source.array()
        self.assertIn('index', packed)
        self.read_without_scan(packed)
        packer = AnalysisCachePacker()
        packer.seed('opponent', values, packed)
        self.assertIs(packer.pack('opponent', values), packed)
        del values[0]['模型-0']
        values[1]['new'] = {'probability': [0, 1]}
        expected[0].clear()
        expected[1]['new'] = {'probability': [0, 1]}
        values.reverse()
        expected.reverse()
        changed = packer.pack('opponent', values)
        reread = self.read_without_scan(changed)
        self.assertEqual(source.array_decodes, 0)
        self.assertEqual(copy.deepcopy(reread), expected)
        self.assertIs(packer.pack('opponent', values), changed)
        # The no-packer writer must produce the same reusable index.
        record = {'game': {'nodes': {str(i): {'opponentAnalysisCache': value}
                                   for i, value in enumerate(values)}}}
        compact_record_analysis_caches(record)
        with patch.object(_TokenCursor, 'scan', side_effect=AssertionError('scan')):
            expand_record_analysis_caches(record, lazy=True)
        self.assertEqual(source.array_decodes, 0)
        self.assertEqual([node['opponentAnalysisCache'] for node in record['game']['nodes'].values()], expected)

    def test_new_arrays_stay_encoded_when_extending_loaded_record(self):
        expected = self.values()
        first = pack_json(expected, indexed=True)
        loaded = self.read_without_scan(first)
        loaded.append({'another': {'probability': [1, 0]}})
        expected.append({'another': {'probability': [1, 0]}})
        second = pack_json(loaded, indexed=True, strings_seed=json_string_seed(loaded))
        self.assertEqual(copy.deepcopy(self.read_without_scan(second)), expected)

    def test_corrupt_index_rejected_before_cache_attachment(self):
        record = {'game': {'nodes': {'a': {'analysisCache': self.values()[0]}}}}
        compact_record_analysis_caches(record)
        for mutate in (
            lambda p: p['index'].update(version=2),
            lambda p: p['index'].update(digest='wrong'),
            lambda p: p.update(numbers=p['numbers'] + 'AAAA'),
            lambda p: p['index']['values'][0].__setitem__(1, 10**9),
        ):
            broken = copy.deepcopy(record)
            mutate(broken['analysisCacheStorage']['decision']['values'])
            with self.assertRaises(ValueError):
                expand_record_analysis_caches(broken, lazy=True)
            self.assertNotIn('analysisCache', broken['game']['nodes']['a'])
            live = {'game': {'comment': 'unsaved'}, 'gameLoaded': True}
            session = RecordSession(live, SimpleNamespace())
            previous_packer = session._analysis_packer
            with self.assertRaises(ValueError):
                session.load(broken, take_ownership=True)
            self.assertEqual(live, {'game': {'comment': 'unsaved'}, 'gameLoaded': True})
            self.assertIs(session._analysis_packer, previous_packer)

    def test_digest_is_not_a_substitute_for_span_validation(self):
        packed = pack_json(self.values(), indexed=True)
        for mutate in (
            lambda i: i['values'][0].__setitem__(0, 0),
            lambda i: i['values'][0].__setitem__(3, 10**9),
            lambda i: i['objects'].append(i['objects'][0]),
            lambda i: i['objects'].clear(),
            lambda i: i['objects'][0][1][0].__setitem__(0, -1),
        ):
            broken = copy.deepcopy(packed)
            mutate(broken['index'])
            attach_index(broken, broken['index']['values'], broken['index']['objects'])
            with self.assertRaises(ValueError):
                index_json_array(broken)

    def test_legacy_save_and_fresh_process_reopen_retains_all_predictions(self):
        values = self.values()
        record = {'game': {'nodes': {str(i): {'opponentAnalysisCache': value}
                                   for i, value in enumerate(values)}}}
        compact_record_analysis_caches(record)
        # Reproduce a file made before indexes were persisted.
        for kind in ('decision', 'opponent'):
            record['analysisCacheStorage'][kind]['values'].pop('index')
        with tempfile.TemporaryDirectory(prefix='rms-index-test-') as directory:
            path = Path(directory) / 'record.mjstudio'
            RecordFileWriter().write(path, record)
            legacy = read_record_file(path)
            packer = AnalysisCachePacker()
            expand_record_analysis_caches(legacy, packer=packer, lazy=True)
            compact_record_analysis_caches(legacy, packer=packer)
            saved = Path(directory) / 'saved.mjstudio'
            RecordFileWriter().write(saved, legacy)
            code = '''
import copy, json, sys
from unittest.mock import patch
from rms_backend.analysis_cache_codec import _TokenCursor
from rms_backend.analysis_cache_storage import expand_record_analysis_caches
from rms_backend.record_file import read_record_file
record = read_record_file(sys.argv[1])
with patch.object(_TokenCursor, 'scan', side_effect=AssertionError('index rebuilt')):
    expand_record_analysis_caches(record, lazy=True)
values = [node['opponentAnalysisCache'] for node in record['game']['nodes'].values()]
print(json.dumps(copy.deepcopy(values), ensure_ascii=True))
'''
            result = subprocess.run([sys.executable, '-c', code, str(saved)],
                                    cwd=Path(__file__).resolve().parents[1],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), values)


if __name__ == '__main__':
    unittest.main()
