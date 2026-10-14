import copy
import unittest
from threading import Thread
from unittest.mock import patch

from rms_backend import service
from rms_backend.records import session as record_session


class CreateGameFailureTests(unittest.TestCase):
    def test_candidate_advance_runs_without_swapping_or_locking_the_live_record(self):
        observed = []
        def prepare(game, seat):
            self.assertIs(service.STATE['game'], self.old_game)
            self.assertEqual(service.STATE['controlledSeat'], 2)
            def check_lock():
                acquired = service._STATE_LOCK.acquire(blocking=False)
                observed.append(acquired)
                if acquired:
                    service._STATE_LOCK.release()
            thread = Thread(target=check_lock)
            thread.start()
            thread.join(2)
        with patch.object(service.RECORD_SESSION.dependencies, 'advance_new_game', side_effect=prepare), \
             patch.object(service.SERVICE_RUNTIME.background, 'submit'):
            service.STATEFUL_COMMANDS.dispatch('test', 'create_game', {})
        self.assertEqual(observed, [True])
        self.assertEqual(self.old_game, self.old_copy)
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
        def fail(game, seat):
            self.assertIsNot(game, self.old_game)
            game['nodes']['n_root']['comment'] = 'abandoned'
            raise RuntimeError('engine unavailable')
        with patch.object(service.RECORD_SESSION.dependencies, 'advance_new_game', side_effect=fail), \
             patch.object(service.RECORD_SESSION.dependencies, 'reset_runtime') as reset:
            with self.assertRaisesRegex(RuntimeError, 'engine unavailable'):
                service.RECORD_SESSION.create()
            reset.assert_not_called()
        self.assertIs(service.STATE['game'], self.old_game)
        self.assertEqual(self.old_game, self.old_copy)
        for key, value in self.expected.items():
            self.assertEqual(service.STATE[key], value)

    def test_prewarm_submission_failure_also_rolls_back(self):
        with patch.object(service.RECORD_SESSION.dependencies, 'advance_new_game'), \
             patch.object(service.RECORD_SESSION.dependencies, 'reset_runtime'), \
             patch.object(service.SERVICE_RUNTIME.background, 'submit', side_effect=RuntimeError('executor closed')):
            with self.assertRaisesRegex(RuntimeError, 'executor closed'):
                service.RECORD_SESSION.create()
        self.assertIs(service.STATE['game'], self.old_game)

    def test_real_advance_with_unavailable_engine_keeps_exportable_record(self):
        before = service.RECORD_SESSION.serialize()
        with patch.object(record_session.random, 'randint', side_effect=[123456, 1]), \
             patch.object(
                 service.ACTION_RECOMMENDATIONS,
                 'analyze_candidates',
                 side_effect=RuntimeError('engine unavailable'),
             ):
            with self.assertRaisesRegex(Exception, 'engine unavailable|引擎未加载'):
                service.STATEFUL_COMMANDS.dispatch('test', 'create_game', {})
        after = service.RECORD_SESSION.serialize()
        self.assertEqual(before['game'], after['game'])
        self.assertEqual(before['state'], after['state'])

    def test_success_replaces_old_record(self):
        with patch.object(service.RECORD_SESSION.dependencies, 'advance_new_game'), \
             patch.object(service.RECORD_SESSION.dependencies, 'reset_runtime') as reset, \
             patch.object(service.SERVICE_RUNTIME.background, 'submit'):
            service.RECORD_SESSION.create()
            reset.assert_called_once()
        self.assertIsNot(service.STATE['game'], self.old_game)
        self.assertEqual(service.STATE['mode'], 'play')
        self.assertEqual(self.old_game, self.old_copy)


if __name__ == '__main__':
    unittest.main()
