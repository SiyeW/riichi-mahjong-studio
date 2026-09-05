import copy
import unittest
from unittest.mock import patch

import service


class ImportGameFailureTests(unittest.TestCase):
    def setUp(self):
        self.saved = dict(service.STATE)
        self.old_game = service.create_empty_game(123456)
        self.old_game['nodes']['n_root']['comment'] = 'unsaved comment'
        service.STATE.update(game=self.old_game, gameLoaded=True, mode='research',
                             controlledSeat=2, pendingSeatSwitch=1, visibleHands=True)
        self.before = service.serialize_game_record()
        self.record = {
            'formatVersion': 2,
            'game': service.create_empty_game(654321),
            'state': {'mode': 'research', 'controlledSeat': 0},
        }

    def tearDown(self):
        service.STATE.clear()
        service.STATE.update(self.saved)

    def assert_old_record_preserved(self):
        self.assertIs(service.STATE['game'], self.old_game)
        after = service.serialize_game_record()
        self.assertEqual(after['game'], self.before['game'])
        self.assertEqual(after['state'], self.before['state'])
        self.assertEqual(service.STATE['pendingSeatSwitch'], 1)

    def test_late_import_failures_restore_old_record(self):
        for stage in ('normalize_current_tree_cursor', 'backfill_cached_child_comparisons',
                      'request_current_opponent_analysis'):
            with self.subTest(stage=stage):
                with patch.object(service, stage, side_effect=RuntimeError('import failed')), \
                     patch.object(service, 'reset_runtime_for_game_change') as reset:
                    with self.assertRaisesRegex(RuntimeError, 'import failed'):
                        service.load_game_record(copy.deepcopy(self.record))
                    self.assertEqual(reset.call_count, 2)
                self.assert_old_record_preserved()

    def test_invalid_session_state_does_not_stop_current_runtime(self):
        self.record['state'] = ['invalid state']
        with patch.object(service, 'reset_runtime_for_game_change') as reset:
            with self.assertRaises((ValueError, AttributeError)):
                service.load_game_record(self.record)
            reset.assert_not_called()
        self.assert_old_record_preserved()

    def test_success_commits_candidate_and_preserves_old_object(self):
        old_copy = copy.deepcopy(self.old_game)
        with patch.object(service, 'request_current_opponent_analysis'), \
             patch.object(service, 'reset_runtime_for_game_change') as reset:
            service.load_game_record(self.record)
            reset.assert_called_once()
        self.assertIsNot(service.STATE['game'], self.old_game)
        self.assertEqual(self.old_game, old_copy)
        self.assertEqual(service.STATE['controlledSeat'], 0)


if __name__ == '__main__':
    unittest.main()
