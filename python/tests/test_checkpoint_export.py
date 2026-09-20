import copy
import unittest
from unittest.mock import patch

from rms_backend import service
from rms_backend.analysis_cache import OPPONENT_ANALYSIS_CACHE_FIELD
from rms_backend.analysis_cache_storage import expand_record_analysis_caches


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
            result = service.STATEFUL_COMMANDS.dispatch(
                'request', 'export_game_record', {'checkpoint': True}
            )
            record = result['record']
            self.assertEqual(game, before, 'compaction must not mutate the live record')
            frozen = copy.deepcopy(record)
            node['comment'] = 'later comment'
            node[OPPONENT_ANALYSIS_CACHE_FIELD]['test']['probabilities'][0] = 0.9
            node['snapshot']['scores'][0] += 1000
            service.STATE['controlledSeat'] = 2
            service.STATE['visibleHands'] = False
            self.assertEqual(record, frozen)

    def test_checkpoint_omits_recomputable_analysis_without_mutating_live_record(self):
        game = service.create_empty_game(123456)
        node_id = game['currentNodeId']
        node = game['nodes'][node_id]
        node['analysisCache'] = {'decision': {'probabilities': [0.2, 0.8]}}
        node[OPPONENT_ANALYSIS_CACHE_FIELD] = {
            'opponent': {'probabilities': [0.3, 0.7]}
        }
        with patch.dict(service.STATE, {
            'game': game, 'gameLoaded': True, 'mode': 'play',
            'controlledSeat': 0, 'pendingSeatSwitch': None, 'visibleHands': False,
        }):
            result = service.STATEFUL_COMMANDS.dispatch(
                'request', 'export_game_record', {'checkpoint': True}
            )

        exported_node = result['record']['game']['nodes'][node_id]
        self.assertNotIn('analysisCache', exported_node)
        self.assertNotIn(OPPONENT_ANALYSIS_CACHE_FIELD, exported_node)
        self.assertIn('analysisCache', node)
        self.assertIn(OPPONENT_ANALYSIS_CACHE_FIELD, node)

    def test_normal_export_keeps_analysis_caches(self):
        game = service.create_empty_game(123456)
        node_id = game['currentNodeId']
        game['nodes'][node_id]['analysisCache'] = {
            'decision': {'probabilities': [0.2, 0.8]}
        }
        with patch.dict(service.STATE, {
            'game': game, 'gameLoaded': True, 'mode': 'play',
            'controlledSeat': 0, 'pendingSeatSwitch': None, 'visibleHands': False,
        }):
            record = service.RECORD_SESSION.serialize()
        expand_record_analysis_caches(record)
        self.assertIn('decision', record['game']['nodes'][node_id]['analysisCache'])

    def test_changing_exported_cache_cannot_change_live_analysis(self):
        game = service.create_empty_game(123456)
        node_id = game['currentNodeId']
        node = game['nodes'][node_id]
        node[OPPONENT_ANALYSIS_CACHE_FIELD] = {'test': {'probabilities': [0.2, 0.8]}}
        with patch.dict(service.STATE, {'game': game, 'gameLoaded': True}):
            record = service.RECORD_SESSION.serialize()
        expand_record_analysis_caches(record)
        record['game']['nodes'][node_id][OPPONENT_ANALYSIS_CACHE_FIELD]['test']['probabilities'].clear()
        self.assertEqual(node[OPPONENT_ANALYSIS_CACHE_FIELD]['test']['probabilities'], [0.2, 0.8])

    def test_checkpoint_exports_record_without_building_or_consuming_ui_state(self):
        record = {'game': {'gameId': 'test'}}
        with patch.object(service.RECORD_SESSION, 'serialize', return_value=record) as serialize, \
             patch.object(service.VIEW_BUILDER, 'build_view_payload', side_effect=AssertionError('unneeded view')), \
             patch.object(service.VIEW_BUILDER, 'build_state_payload', side_effect=AssertionError('unneeded runtime state')):
            result = service.STATEFUL_COMMANDS.dispatch(
                'request', 'export_game_record', {'checkpoint': True}
            )
        self.assertIs(result['record'], record)
        self.assertEqual(result['request_id'], 'request')
        self.assertNotIn('view', result)
        self.assertIn('analysisVisibility', result['state'])
        serialize.assert_called_once_with(recovery_checkpoint=True)

    def test_normal_export_keeps_the_existing_response(self):
        with patch.object(service.RECORD_SESSION, 'serialize', return_value={'game': {}}), \
             patch.object(service.VIEW_BUILDER, 'build_response', return_value={'view': 'unchanged'}) as build:
            result = service.STATEFUL_COMMANDS.dispatch(
                'request', 'export_game_record', {}
            )
        self.assertEqual(result, {'view': 'unchanged'})
        build.assert_called_once()


if __name__ == '__main__':
    unittest.main()
