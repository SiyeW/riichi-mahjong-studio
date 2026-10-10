import base64
import copy
import json
import unittest
from unittest.mock import patch

from rms_backend.analysis_cache_codec import (
    DeferredJsonObject, PackedJsonIndex, index_json_array, pack_json,
    snapshot_json_object, unpack_json,
)
from rms_backend.analysis_cache_storage import (
    AnalysisCachePacker, compact_record_analysis_caches, expand_record_analysis_caches,
)
from rms_backend.analysis_cache import migrate_analysis_cache_storage
from rms_backend.auto_analysis_plan import item_is_cached


class DeferredAnalysisCacheTests(unittest.TestCase):
    def fixture(self):
        values = [{f'model-{i}': {
            'status': 'complete', 'error': None,
            'probability': [0, .25, .75, 1],
            'outputs': {'nested': [{'probability': .125, 'score': 12000}, None]},
        }} for i in range(3)]
        packed = pack_json(values)
        index = PackedJsonIndex(packed)
        return values, index, index.array()

    def test_metadata_and_keys_do_not_decode_vectors(self):
        expected, index, values = self.fixture()
        self.assertEqual(list(values[0]), ['model-0'])
        self.assertEqual(values[0]['model-0'].get('status'), 'complete')
        self.assertIsNone(values[0]['model-0'].get('error'))
        self.assertEqual(index.array_decodes, 0)
        self.assertEqual(values[0]['model-0']['probability'], expected[0]['model-0']['probability'])
        self.assertEqual(index.array_decodes, 1)
        self.assertEqual(values[0]['model-0']['probability'], expected[0]['model-0']['probability'])
        self.assertEqual(index.array_decodes, 1)
        self.assertEqual(copy.deepcopy(values), expected)
        self.assertEqual(json.loads(json.dumps(values)), expected)

    def test_dictionary_interface_and_snapshot_isolation(self):
        expected, index, values = self.fixture()
        cache = values[0]
        before = snapshot_json_object(cache)
        self.assertIsInstance(cache, dict)
        self.assertEqual(dict(cache), expected[0])
        self.assertEqual(cache.copy(), expected[0])
        cache.update({'new': {'probability': [1]}})
        self.assertEqual(cache.setdefault('new', None), {'probability': [1]})
        self.assertEqual(cache.popitem(), ('new', {'probability': [1]}))
        del cache['model-0']
        self.assertEqual(len(cache), 0)
        self.assertEqual(unpack_json(pack_json([before], strings_seed=index.strings)), [expected[0]])
        cache['new'] = 4
        cache.clear()
        self.assertEqual(list(cache), [])

    def test_multibyte_indexes_and_mixed_arrays(self):
        expected = [{f'key-{i}': [0, i, None, False, True, f'label-{i}', {'x': [1, 0]}]
                     for i in range(260)}]
        self.assertEqual(copy.deepcopy(index_json_array(pack_json(expected))), expected)

    def test_untouched_and_changed_save_preserve_hidden_results(self):
        expected, index, values = self.fixture()
        packer = AnalysisCachePacker()
        packed = pack_json(expected)
        packer.seed('opponent', values, packed)
        with patch('rms_backend.analysis_cache_storage.pack_json', wraps=pack_json) as encode:
            self.assertIs(packer.pack('opponent', values), packed)
            encode.assert_not_called()
        values[0]['new'] = {'probability': [0, 1]}
        del values[1]['model-1']
        expected[0]['new'] = {'probability': [0, 1]}
        expected[1].clear()
        self.assertEqual(unpack_json(packer.pack('opponent', values)), expected)
        self.assertEqual(index.array_decodes, 0)
        record = {'game': {'nodes': {str(i): {'opponentAnalysisCache': value}
                                   for i, value in enumerate(values)}}}
        compact_record_analysis_caches(record)
        expand_record_analysis_caches(record)
        self.assertEqual([node['opponentAnalysisCache'] for node in record['game']['nodes'].values()], expected)
        self.assertEqual(index.array_decodes, 0)

    def test_zero_bitmap_slices_at_every_bit_boundary(self):
        numbers = [0 if i % 3 else i + 1 for i in range(50)]
        index = PackedJsonIndex(pack_json([{'x': numbers}]))
        for start in range(50):
            for length in range(51 - start):
                bits = [value == 0 for value in numbers[start:start + length]]
                self.assertEqual(index.bits(start, length), bits)
                self.assertEqual(index.zero_count(start, length), sum(bits))

    def test_migration_statistics_and_clearing_stay_deferred(self):
        key = 'o5::0::public::source'
        index = PackedJsonIndex(pack_json([{key: {'status': 'ready', 'probability': [0, 1]},
                                           'obsolete': {'probability': [0, 1]}}]))
        cache = index.array()[0]
        node = {'opponentAnalysisCache': cache}
        game = {'nodes': {'a': node}}
        migrate_analysis_cache_storage(game)
        self.assertEqual(list(cache), [key])
        self.assertTrue(item_is_cached(game, {'kind': 'opponent', 'nodeId': 'a', 'cacheKey': key}))
        self.assertEqual(index.array_decodes, 0)
        packer = AnalysisCachePacker()
        packer.pack('opponent', [cache])
        del node['opponentAnalysisCache']
        record = {'game': game}
        compact_record_analysis_caches(record, packer=packer)
        expand_record_analysis_caches(record)
        self.assertNotIn('opponentAnalysisCache', node)
        self.assertEqual(index.array_decodes, 0)

    def test_invalid_hidden_tokens_are_rejected_before_attaching_caches(self):
        record = {'game': {'nodes': {'a': {'analysisCache': {'m': {'probability': [0, 1]}}}}}}
        compact_record_analysis_caches(record)
        original = copy.deepcopy(record)
        packed = record['analysisCacheStorage']['decision']['values']
        tokens = base64.b64decode(packed['tokens'])
        packed['tokens'] = base64.b64encode(tokens + b'\x00').decode()
        with self.assertRaises(ValueError):
            expand_record_analysis_caches(record, lazy=True)
        self.assertNotIn('analysisCache', record['game']['nodes']['a'])
        for data in (b'', b'\x05\x01\xff', b'\x05\x01\x04\xff\x7f', b'\x05\x01\x06\x01'):
            invalid = {**original['analysisCacheStorage']['decision']['values'], 'tokens': base64.b64encode(data).decode()}
            with self.assertRaises(ValueError):
                index_json_array(invalid)


if __name__ == '__main__':
    unittest.main()
