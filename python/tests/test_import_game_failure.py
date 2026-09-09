import copy
from contextlib import ExitStack
import unittest
from unittest.mock import patch

from rms_backend import service
from rms_backend import record_session


class ImportGameFailureTests(unittest.TestCase):
    def setUp(self):
        self.saved = dict(service.STATE)
        self.old_game = service.create_empty_game(123456)
        self.old_game['nodes']['n_root']['comment'] = 'unsaved comment'
        service.STATE.update(game=self.old_game, gameLoaded=True, mode='research',
                             controlledSeat=2, pendingSeatSwitch=1, visibleHands=True)
        self.before = service.RECORD_SESSION.serialize()
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
        after = service.RECORD_SESSION.serialize()
        self.assertEqual(after['game'], self.before['game'])
        self.assertEqual(after['state'], self.before['state'])
        self.assertEqual(service.STATE['pendingSeatSwitch'], 1)

    def test_late_import_failures_restore_old_record(self):
        for stage in ('normalize_current_tree_cursor', 'backfill_cached_child_comparisons',
                      'request_current_opponent_analysis'):
            with self.subTest(stage=stage):
                target, attribute = (
                    (record_session.tree_view, 'normalize_current_cursor')
                    if stage == 'normalize_current_tree_cursor'
                    else (service.RECORD_SESSION.dependencies, {
                        'backfill_cached_child_comparisons': 'backfill_child_comparisons',
                        'request_current_opponent_analysis': 'request_opponent_analysis',
                    }[stage])
                )
                with patch.object(target, attribute, side_effect=RuntimeError('import failed')), \
                     patch.object(service.RECORD_SESSION.dependencies, 'reset_runtime') as reset:
                    with self.assertRaisesRegex(RuntimeError, 'import failed'):
                        service.RECORD_SESSION.load(copy.deepcopy(self.record))
                    self.assertEqual(reset.call_count, 2)
                self.assert_old_record_preserved()

    def test_invalid_session_state_does_not_stop_current_runtime(self):
        self.record['state'] = ['invalid state']
        with patch.object(service.RECORD_SESSION.dependencies, 'reset_runtime') as reset:
            with self.assertRaises((ValueError, AttributeError)):
                service.RECORD_SESSION.load(self.record)
            reset.assert_not_called()
        self.assert_old_record_preserved()

    def test_success_commits_candidate_and_preserves_old_object(self):
        old_copy = copy.deepcopy(self.old_game)
        with patch.object(service.RECORD_SESSION.dependencies, 'request_opponent_analysis'), \
             patch.object(service.RECORD_SESSION.dependencies, 'reset_runtime') as reset:
            service.RECORD_SESSION.load(self.record)
            reset.assert_called_once()
        self.assertIsNot(service.STATE['game'], self.old_game)
        self.assertEqual(self.old_game, old_copy)
        self.assertEqual(service.STATE['controlledSeat'], 0)

    def import_external_record(self, kind, stack, **options):
        candidate = copy.deepcopy(self.record['game'])
        if kind == 'mortal':
            stack.enter_context(patch.object(record_session, 'build_mortal_report_game', return_value=(candidate, 0)))
            stack.enter_context(patch.object(record_session, 'attach_mortal_review_cache', return_value={}))
            return service.RECORD_SESSION.import_mortal({}, 'https://example.org/report.json', **options)
        stack.enter_context(patch.object(record_session, 'normalize_custom_tenhou_input', return_value={}))
        stack.enter_context(patch.object(record_session, 'build_custom_tenhou_game', return_value=(candidate, 0)))
        return service.RECORD_SESSION.import_custom({}, **options)

    def test_external_import_initialization_failure_restores_old_record(self):
        for kind in ('mortal', 'tenhou'):
            for stage in ('get_current_snapshot', 'request_current_opponent_analysis'):
                with self.subTest(kind=kind, stage=stage), ExitStack() as stack:
                    dependency = 'current_snapshot' if stage == 'get_current_snapshot' else 'request_opponent_analysis'
                    stack.enter_context(patch.object(service.RECORD_SESSION.dependencies, dependency, side_effect=RuntimeError('activation failed')))
                    reset = stack.enter_context(patch.object(service.RECORD_SESSION.dependencies, 'reset_runtime'))
                    with self.assertRaisesRegex(RuntimeError, 'activation failed'):
                        self.import_external_record(kind, stack)
                    self.assertEqual(reset.call_count, 2)
                self.assert_old_record_preserved()

    def test_external_reconstruction_failure_does_not_stop_old_runtime(self):
        for kind in ('mortal', 'tenhou'):
            with self.subTest(kind=kind), ExitStack() as stack:
                stack.enter_context(patch.object(record_session, 'reconstruct_imported_walls',
                                                side_effect=ValueError('invalid wall')))
                reset = stack.enter_context(patch.object(service.RECORD_SESSION.dependencies, 'reset_runtime'))
                with self.assertRaisesRegex(ValueError, 'invalid wall'):
                    self.import_external_record(kind, stack, reconstruct_walls=True)
                reset.assert_not_called()
            self.assert_old_record_preserved()

    def test_external_import_success_commits_candidate(self):
        for kind in ('mortal', 'tenhou'):
            with self.subTest(kind=kind), ExitStack() as stack:
                stack.enter_context(patch.object(service.RECORD_SESSION.dependencies, 'request_opponent_analysis'))
                reset = stack.enter_context(patch.object(service.RECORD_SESSION.dependencies, 'reset_runtime'))
                self.assertIsNone(self.import_external_record(kind, stack))
                reset.assert_called_once()
                self.assertIsNot(service.STATE['game'], self.old_game)
                self.assertEqual(service.STATE['mode'], 'research')
                self.assertEqual(service.STATE['controlledSeat'], 0)
                self.assertFalse(service.STATE['visibleHands'])


if __name__ == '__main__':
    unittest.main()
