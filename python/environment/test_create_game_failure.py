import copy
import unittest
from unittest.mock import patch

import service


class CreateGameFailureTests(unittest.TestCase):
    def setUp(self):
        self.saved = dict(service.STATE)
        self.old_game = service.create_empty_game(123456)
        self.old_game['nodes']['n_root']['comment'] = 'unsaved comment'
        service.STATE.update(game=self.old_game, gameLoaded=True, mode='research',
                             controlledSeat=2, pendingSeatSwitch=1, visibleHands=True)
        self.expected = {key: service.STATE[key] for key in (
            'game', 'gameLoaded', 'mode', 'controlledSeat', 'pendingSeatSwitch', 'visibleHands')}
        self.old_copy = copy.deepcopy(self.old_game)

    def tearDown(self):
        service.STATE.clear()
        service.STATE.update(self.saved)

    def test_partial_advance_failure_restores_old_record(self):
        def fail(game):
            self.assertIsNot(game, self.old_game)
            game['nodes']['n_root']['comment'] = 'abandoned'
            raise RuntimeError('engine unavailable')
        with patch.object(service, 'advance_to_next_user_turn', side_effect=fail), \
             patch.object(service, 'reset_runtime_for_game_change') as reset:
            with self.assertRaisesRegex(RuntimeError, 'engine unavailable'):
                service.create_game()
            self.assertEqual(reset.call_count, 2)
        self.assertIs(service.STATE['game'], self.old_game)
        self.assertEqual(self.old_game, self.old_copy)
        for key, value in self.expected.items():
            self.assertEqual(service.STATE[key], value)

    def test_prewarm_submission_failure_also_rolls_back(self):
        with patch.object(service, 'advance_to_next_user_turn'), \
             patch.object(service, 'reset_runtime_for_game_change'), \
             patch.object(service._BG_EXECUTOR, 'submit', side_effect=RuntimeError('executor closed')):
            with self.assertRaisesRegex(RuntimeError, 'executor closed'):
                service.create_game()
        self.assertIs(service.STATE['game'], self.old_game)

    def test_real_advance_with_unavailable_engine_keeps_exportable_record(self):
        before = service.serialize_game_record()
        with patch.object(service.random, 'randint', side_effect=[123456, 1]), \
             patch.object(service.ACTION_RECOMMENDATIONS, 'analyze_candidates', side_effect=RuntimeError('engine unavailable')):
            with self.assertRaisesRegex(Exception, 'engine unavailable|引擎未加载'):
                service.handle_command('test', 'create_game', {})
        after = service.serialize_game_record()
        self.assertEqual(before['game'], after['game'])
        self.assertEqual(before['state'], after['state'])

    def test_success_replaces_old_record(self):
        with patch.object(service, 'advance_to_next_user_turn'), \
             patch.object(service, 'reset_runtime_for_game_change') as reset, \
             patch.object(service._BG_EXECUTOR, 'submit'):
            service.create_game()
            reset.assert_called_once()
        self.assertIsNot(service.STATE['game'], self.old_game)
        self.assertEqual(service.STATE['mode'], 'play')
        self.assertEqual(self.old_game, self.old_copy)


if __name__ == '__main__':
    unittest.main()
