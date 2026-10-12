import copy
import unittest
from unittest.mock import patch

from rms_backend import service
from rms_backend import game_record_storage
from rms_backend.analysis_cache import OPPONENT_ANALYSIS_CACHE_FIELD
from rms_backend.analysis_cache_storage import expand_record_analysis_caches
from rms_backend.game_record_storage import copy_game_for_record, serialize_game_record_parts


class CheckpointExportTests(unittest.TestCase):
    def test_persisted_projection_matches_full_copy_and_never_mutates_source(self):
        game = service.create_empty_game(123456)
        snapshot = game['nodes'][game['currentNodeId']]['snapshot']
        snapshot['kyokuState']['pendingDoraRevealAfterActionCount'] = 2
        before = copy.deepcopy(game)
        state = {'mode': 'research', 'controlledSeat': 0, 'visibleHands': True}
        full_copy = copy.deepcopy(game)
        for node in full_copy['nodes'].values():
            saved = node['snapshot']
            kyoku = saved.pop('kyokuState', {})
            saved.pop('matchState', None)
            if kyoku.get('pendingDoraRevealAfterActionCount'):
                saved['pendingDoraRevealAfterActionCount'] = int(kyoku['pendingDoraRevealAfterActionCount'])
        game_record_storage._compact_round_walls_for_record(full_copy)
        game_record_storage._compact_round_states_for_record(full_copy)
        game_record_storage._compact_game_structure_for_record(full_copy)
        game_record_storage._sanitize_record_actions(full_copy)
        expected = serialize_game_record_parts(full_copy, state)
        actual = serialize_game_record_parts(copy_game_for_record(game), state)
        expected.pop('savedAt')
        actual.pop('savedAt')
        self.assertEqual(actual, expected)
        self.assertEqual(game, before)

    def test_projected_save_detaches_mutable_snapshot_data(self):
        game = service.create_empty_game(123456)
        node_id = game['currentNodeId']
        detached = copy_game_for_record(game)
        snapshot = game['nodes'][node_id]['snapshot']
        self.assertNotIn('kyokuState', detached['nodes'][node_id]['snapshot'])
        frozen = copy.deepcopy(detached)
        snapshot['hands'][0].append('1m')
        snapshot['rivers'][0].append({'pai': '2m'})
        snapshot['scores'][0] += 1000
        self.assertEqual(detached, frozen)

    def test_projection_does_not_copy_history_prefixes_or_discarded_walls(self):
        class History(list):
            def __deepcopy__(self, memo):
                raise AssertionError('full history copied before selecting deltas')

        class Wall(tuple):
            def __deepcopy__(self, memo):
                raise AssertionError('per-frame static wall copied')

        event = {'type': 'dahai', 'pai': '1m', 'meta': {'error': 'runtime'}}
        wall = Wall(['1m'] * 136)
        game = {'rootNodeId': 'root', 'nodes': {
            'root': {'children': ['left', 'right'], 'snapshot': {
                'fullWall': wall, 'wall': wall[:122], 'actionHistory': History([event])}},
            'left': {'children': [], 'snapshot': {
                'fullWall': wall, 'wall': wall[:121],
                'actionHistory': History([event, {'type': 'tsumo', 'pai': '2m'}])}},
            'right': {'children': [], 'snapshot': {
                'fullWall': wall, 'wall': wall[:120],
                'actionHistory': History([event, {'type': 'tsumo', 'pai': '3m'}])}},
        }}
        prepared = copy_game_for_record(game)
        root = prepared['nodes']['root']['snapshot']
        self.assertNotIn('actionHistory', root)
        self.assertEqual(root['actionHistoryDelta'], [{'type': 'dahai', 'pai': '1m'}])
        self.assertEqual(prepared['nodes']['right']['snapshot']['actionHistoryDelta'],
                         [{'type': 'tsumo', 'pai': '3m'}])
        self.assertEqual(len(prepared['roundWallStorage']['walls']), 1)
        self.assertEqual(event['meta'], {'error': 'runtime'})
        event['pai'] = '9m'
        game['nodes']['left']['snapshot']['actionHistory'][-1]['pai'] = '9p'
        self.assertEqual(root['actionHistoryDelta'][0]['pai'], '1m')
        self.assertEqual(prepared['nodes']['left']['snapshot']['actionHistoryDelta'][0]['pai'], '2m')

    def test_round_static_projection_is_shared_on_disk_but_detached_from_source(self):
        hands = [['1m'], ['2m'], ['3m'], ['4m']]
        game = {'nodes': {str(i): {'snapshot': {'initialHands': copy.deepcopy(hands),
                  'startScores': [25000] * 4, 'startKyotaku': 0}} for i in range(4)}}
        prepared = copy_game_for_record(game)
        states = prepared['roundStateStorage']['states']
        self.assertEqual(len(states), 1)
        for node in prepared['nodes'].values():
            self.assertEqual(node['snapshot']['roundStateRef'], 'r1')
            self.assertNotIn('initialHands', node['snapshot'])
        game['nodes']['0']['snapshot']['initialHands'][0].append('5m')
        self.assertEqual(states['r1']['initialHands'], hands)

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
            result = service._export_recovery_checkpoint(
                'request', 'export_recovery_checkpoint'
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
            result = service._export_recovery_checkpoint(
                'request', 'export_recovery_checkpoint'
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

    def test_normal_export_omits_empty_cache_maps_after_authored_projection(self):
        game = service.create_empty_game(123456)
        for node in game['nodes'].values():
            node['analysisCache'] = {}
            node[OPPONENT_ANALYSIS_CACHE_FIELD] = {}
        with patch.dict(service.STATE, {'game': game, 'gameLoaded': True}):
            record = service.RECORD_SESSION.serialize()
        self.assertNotIn('analysisCacheStorage', record)
        for node in record['game']['nodes'].values():
            self.assertNotIn('analysisCache', node)
            self.assertNotIn(OPPONENT_ANALYSIS_CACHE_FIELD, node)

    def test_prepared_checkpoint_is_detached_before_background_serialization(self):
        game = service.create_empty_game(123456)
        node_id = game['currentNodeId']
        node = game['nodes'][node_id]
        node['comment'] = 'before'
        node['children'] = ['first']
        with patch.dict(service.STATE, {
            'game': game, 'gameLoaded': True, 'mode': 'play',
            'controlledSeat': 0, 'pendingSeatSwitch': None, 'visibleHands': False,
        }):
            prepared = service.RECORD_SESSION.prepare_recovery_checkpoint()
            node['comment'] = 'after'
            node['children'].append('second')
            record = service.RECORD_SESSION.serialize_prepared_recovery_checkpoint(
                prepared
            )

        exported = record['game']['nodes'][node_id]
        self.assertEqual(exported['comment'], 'before')
        self.assertEqual(exported['children'], ['first'])

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
        prepared = ({'gameId': 'test'}, {})
        with patch.object(service.RECORD_SESSION, 'prepare_recovery_checkpoint', return_value=prepared) as prepare, \
             patch.object(service.RECORD_SESSION, 'serialize_prepared_recovery_checkpoint', return_value=record) as serialize, \
             patch.object(service.VIEW_BUILDER, 'build_view_payload', side_effect=AssertionError('unneeded view')), \
             patch.object(service.VIEW_BUILDER, 'build_state_payload', side_effect=AssertionError('unneeded runtime state')):
            result = service._export_recovery_checkpoint(
                'request', 'export_recovery_checkpoint'
            )
        self.assertIs(result['record'], record)
        self.assertEqual(result['request_id'], 'request')
        self.assertNotIn('view', result)
        self.assertIn('analysisVisibility', result['state'])
        prepare.assert_called_once_with()
        serialize.assert_called_once_with(prepared)

    def test_normal_export_keeps_the_existing_response(self):
        with patch.object(service.RECORD_SESSION, 'prepare_export', return_value=({}, {})), \
             patch.object(service.RECORD_SESSION, 'serialize_prepared_export', return_value={'game': {}}), \
             patch.object(service.VIEW_BUILDER, 'build_response', return_value={'view': 'unchanged'}) as build:
            result = service._export_game_record('request', 'export_game_record')
        self.assertEqual(result, {'view': 'unchanged', 'record': {'game': {}}})
        build.assert_called_once()

    def test_full_save_detaches_edits_and_cache_maps_before_packing(self):
        game = service.create_empty_game(123456)
        node_id = game['currentNodeId']
        node = game['nodes'][node_id]
        result = {'probabilities': [0, 1e-12, 0.999999999999]}
        node['comment'] = 'before'
        node['analysisCache'] = {'model': result}
        with patch.dict(service.STATE, {'game': game, 'gameLoaded': True}):
            prepared = service.RECORD_SESSION.prepare_export()
            # Publishing and pruning entries must not change a pending save.
            node['analysisCache']['model'] = {'probabilities': [1, 0, 0]}
            node['analysisCache'].clear()
            node['comment'] = 'after'
            node['snapshot']['scores'][0] += 1000
            record = service.RECORD_SESSION.serialize_prepared_export(prepared)
        expand_record_analysis_caches(record)
        saved = record['game']['nodes'][node_id]
        self.assertEqual(saved['comment'], 'before')
        self.assertEqual(saved['analysisCache']['model'], result)

    def test_full_save_packs_outside_the_gameplay_lock(self):
        import threading
        acquired = []

        def serialize(_prepared):
            def probe():
                locked = service._STATE_LOCK.acquire(timeout=0.5)
                acquired.append(locked)
                if locked:
                    service._STATE_LOCK.release()
            thread = threading.Thread(target=probe)
            thread.start()
            thread.join()
            return {}

        with patch.object(service.RECORD_SESSION, 'prepare_export', return_value=({}, {})), \
             patch.object(service.RECORD_SESSION, 'serialize_prepared_export', side_effect=serialize), \
             patch.object(service.VIEW_BUILDER, 'build_response', return_value={}):
            service._export_game_record('request', 'export_game_record')
        self.assertEqual(acquired, [True])


if __name__ == '__main__':
    unittest.main()
