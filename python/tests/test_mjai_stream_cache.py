import copy
import unittest
from unittest.mock import Mock

from rms_backend.mjai_stream import build_mjai_stream
from rms_backend.mjai_stream_cache import MjaiStreamCache


class MjaiStreamCacheTests(unittest.TestCase):
    def test_cold_and_evicted_nodes_build_only_the_requested_history(self):
        snapshot = dict(roundIndex=0, honba=0, kyoku=1, bakaze='E', kyotaku=0, dealer=0,
            scores=[25000] * 4, initialHands=[['1m'] * 13 for _ in range(4)],
            doraIndicators=['2m'], actionHistory=[], phase='discard')
        game = dict(gameId='stream-cache', nodes={})
        for index in range(101):
            node_id = str(index)
            game['nodes'][node_id] = dict(id=node_id, parentId=str(index-1) if index else None,
                snapshot=copy.deepcopy(snapshot))
            snapshot['actionHistory'].append(dict(type='tsumo' if index % 2 == 0 else 'dahai',
                actor=index % 4, pai='5mr', tsumogiri=True))
        sync = Mock()
        cache = MjaiStreamCache(sync, max_entries=4)
        # Alternate public/full and jump farther than the LRU, as browsing a
        # long round does. Cold access must not recursively populate all parents.
        for node_id in ['100', '99', '20', '70', '69']:
            for full in [False, True]:
                sync.reset_mock()
                result = cache.get_bundle(game, node_id, 0, reveal_all=full)
                expected = build_mjai_stream(game['nodes'][node_id]['snapshot'], 0, reveal_all=full)
                self.assertEqual(result['events'], expected)
                self.assertEqual(result['prefixHashes'], cache._build_prefix_hashes(expected))
                self.assertLessEqual(sync.call_count, 2)
                self.assertLessEqual(len(cache), 4)
        # The normal adjacent path still reuses the retained parent.
        cache.get_bundle(game, '70', 0)
        result = cache.get_bundle(game, '71', 0)
        self.assertEqual(result['events'], build_mjai_stream(game['nodes']['71']['snapshot'], 0))
        self.assertIs(cache.get_bundle(game, '71', 0), result)
