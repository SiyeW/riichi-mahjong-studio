import copy
import unittest
from unittest.mock import patch

import service
from analysis_cache import OPPONENT_ANALYSIS_CACHE_FIELD


class CheckpointExportTests(unittest.TestCase):
    def test_real_checkpoint_is_detached_from_live_record(self):
        game = service.create_empty_game(123456)
        node = game['nodes'][game['currentNodeId']]
        node['comment'] = 'original'
        node[OPPONENT_ANALYSIS_CACHE_FIELD] = {'test': {'probabilities': [0.2, 0.8]}}
        before = copy.deepcopy(game)
        with patch.dict(service.STATE, {
            'game': game, 'gameLoaded': True, 'mode': 'research',
            'controlledSeat': 0, 'pendingSeatSwitch': None, 'visibleHands': True,
        }):
            result = service.handle_command('request', 'export_game_record', {'checkpoint': True})
            record = result['record']
            self.assertEqual(game, before, 'compaction must not mutate the live record')
            frozen = copy.deepcopy(record)
            node['comment'] = 'later comment'
            node[OPPONENT_ANALYSIS_CACHE_FIELD]['test']['probabilities'][0] = 0.9
            node['snapshot']['scores'][0] += 1000
            service.STATE['controlledSeat'] = 2
            service.STATE['visibleHands'] = False
            self.assertEqual(record, frozen)

    def test_changing_exported_cache_cannot_change_live_analysis(self):
        game = service.create_empty_game(123456)
        node_id = game['currentNodeId']
        node = game['nodes'][node_id]
        node[OPPONENT_ANALYSIS_CACHE_FIELD] = {'test': {'probabilities': [0.2, 0.8]}}
        with patch.dict(service.STATE, {'game': game, 'gameLoaded': True}):
            record = service.serialize_game_record()
        record['game']['nodes'][node_id][OPPONENT_ANALYSIS_CACHE_FIELD]['test']['probabilities'].clear()
        self.assertEqual(node[OPPONENT_ANALYSIS_CACHE_FIELD]['test']['probabilities'], [0.2, 0.8])

    def test_checkpoint_exports_record_without_building_or_consuming_ui_state(self):
        record = {'game': {'gameId': 'test'}}
        with patch.object(service, 'serialize_game_record', return_value=record), \
             patch.object(service, 'build_view_payload', side_effect=AssertionError('unneeded view')), \
             patch.object(service, 'build_state_payload', side_effect=AssertionError('unneeded runtime state')):
            result = service.handle_command('request', 'export_game_record', {'checkpoint': True})
        self.assertIs(result['record'], record)
        self.assertEqual(result['request_id'], 'request')
        self.assertNotIn('view', result)
        self.assertIn('analysisVisibility', result['state'])

    def test_normal_export_keeps_the_existing_response(self):
        with patch.object(service, 'serialize_game_record', return_value={'game': {}}), \
             patch.object(service, 'build_response', return_value={'view': 'unchanged'}) as build:
            result = service.handle_command('request', 'export_game_record', {})
        self.assertEqual(result, {'view': 'unchanged'})
        build.assert_called_once()


if __name__ == '__main__':
    unittest.main()
