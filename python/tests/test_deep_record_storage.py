import copy
import unittest

from rms_backend.game_record_storage import (
    _compact_action_histories_for_record,
    _hydrate_action_histories_from_record,
    hydrate_game_structure,
)


def deep_game(reverse=False):
    indices = range(2500)
    if reverse:
        indices = reversed(indices)
    return {'rootNodeId': '0', 'nodes': {
        str(i): {'children': [str(i + 1)] if i < 2499 else [],
                 'snapshot': {'actionHistory': [{'round': i // 100}]}}
        for i in indices
    }}


class DeepRecordStorageTests(unittest.TestCase):
    def test_deep_history_round_trip_preserves_round_resets(self):
        game = deep_game()
        original = copy.deepcopy(game)
        _compact_action_histories_for_record(game)
        _hydrate_action_histories_from_record(game)
        self.assertEqual(game, original)

    def test_reverse_order_deep_nodes_restore_depths(self):
        game = deep_game(reverse=True)
        for node in game['nodes'].values():
            node['snapshot'] = {}
        hydrate_game_structure(game, 3)
        self.assertEqual(game['nodes']['2499']['depth'], 2499)
        self.assertEqual(game['nodes']['0']['depth'], 0)

    def test_cycle_still_rejected(self):
        game = deep_game()
        game['nodes']['2499']['children'] = ['0']
        with self.assertRaises(ValueError):
            _hydrate_action_histories_from_record(game)

    def test_siblings_keep_independent_histories_and_disconnected_roots(self):
        histories = {'root': [1], 'left': [1, 2], 'right': [1, 3], 'reset': [4], 'other': [5]}
        game = {'rootNodeId': 'root', 'nodes': {
            key: {'children': {'root': ['left', 'right'], 'left': ['reset']}.get(key, []),
                  'snapshot': {'actionHistory': history}}
            for key, history in histories.items()
        }}
        original = copy.deepcopy(game)
        _compact_action_histories_for_record(game)
        self.assertEqual(game['nodes']['right']['snapshot']['actionHistoryDelta'], [3])
        self.assertTrue(game['nodes']['reset']['snapshot']['actionHistoryReset'])
        _hydrate_action_histories_from_record(game)
        self.assertEqual(game, original)


if __name__ == '__main__':
    unittest.main()
