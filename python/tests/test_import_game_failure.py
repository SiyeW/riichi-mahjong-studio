import copy
import gzip
import tempfile
from pathlib import Path
from contextlib import ExitStack
import unittest
from unittest.mock import patch

from rms_backend import service
from rms_backend.records import session as record_session
from rms_backend.records.legacy_cache import compact_record_analysis_caches
from tests.legacy_record_fixture import RecordFileWriter, read_record_file


class ImportGameFailureTests(unittest.TestCase):
    def setUp(self):
        self.saved = dict(service.STATE)
        self.saved_packer = service.RECORD_SESSION._analysis_packer
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
        service.RECORD_SESSION._analysis_packer = self.saved_packer

    def test_native_import_reuses_analysis_on_first_save_and_recovery(self):
        self.record['game']['nodes']['n_root']['opponentAnalysisCache'] = {
            'o5::0::visible::o-test': {'status': 'ready', 'probability': [0, .25, .75]},
        }
        for node in self.record['game']['nodes'].values():
            for field in ('analysisCache', 'opponentAnalysisCache'):
                if node.get(field) == {}:
                    del node[field]
        compact_record_analysis_caches(self.record)
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(service.RECORD_SESSION.dependencies, 'request_opponent_analysis'), \
             patch.object(service.RECORD_SESSION.dependencies, 'reset_runtime'), \
             patch.object(service.VIEW_BUILDER, 'build_response', side_effect=lambda _id, _cmd, extra: extra):
            source = Path(directory) / 'source'
            RecordFileWriter().write(source, self.record)
            service.STATEFUL_COMMANDS.dispatch(1, 'import_game_record', {'path': str(source)})
            service.STATE['game']['nodes']['n_root']['comment'] = 'new comment'
            for recovery in (False, True):
                prepared = service.RECORD_SESSION.prepare_export()
                document = service.RECORD_SESSION.serialize_prepared_export(prepared)
                target = Path(directory) / str(recovery)
                RecordFileWriter().write(target, document, recovery=recovery)
                saved = read_record_file(target)
                self.assertEqual(saved['analysisCacheStorage'], self.record['analysisCacheStorage'])
                self.assertEqual(saved['game']['nodes']['n_root']['comment'], 'new comment')

    def test_failed_native_activation_does_not_commit_candidate_analysis_owner(self):
        previous_packer = service.RECORD_SESSION._analysis_packer
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source'
            RecordFileWriter().write(source, self.record)
            with patch.object(service.RECORD_SESSION.dependencies, 'request_opponent_analysis',
                              side_effect=RuntimeError('activation failed')), \
                 patch.object(service.RECORD_SESSION.dependencies, 'reset_runtime'):
                with self.assertRaisesRegex(RuntimeError, 'activation failed'):
                    service.STATEFUL_COMMANDS.dispatch(1, 'import_game_record', {'path': str(source)})
        self.assertIs(service.RECORD_SESSION._analysis_packer, previous_packer)
        self.assert_old_record_preserved()

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
                    # Cursor normalization now belongs to private candidate
                    # preparation; its failure must not stop the live runtime.
                    self.assertEqual(reset.call_count, 0 if stage == 'normalize_current_tree_cursor' else 2)
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

    def test_borrowed_record_is_not_mutated_and_owned_record_is_not_copied(self):
        original = copy.deepcopy(self.record)
        with patch.object(service.RECORD_SESSION.dependencies, 'request_opponent_analysis'), \
             patch.object(service.RECORD_SESSION.dependencies, 'reset_runtime'):
            service.RECORD_SESSION.load(self.record)
            self.assertEqual(self.record, original)
            self.assertIsNot(service.STATE['game'], self.record['game'])
            service.RECORD_SESSION.load(self.record, take_ownership=True)
            self.assertIs(service.STATE['game'], self.record['game'])

    def test_failed_file_read_does_not_replace_active_game(self):
        with patch('rms_backend.records.commands.read_record_file', side_effect=ValueError('damaged')), \
             patch.object(service.RECORD_SESSION.dependencies, 'reset_runtime') as reset:
            with self.assertRaisesRegex(ValueError, 'damaged'):
                service.STATEFUL_COMMANDS.dispatch(1, 'import_game_record', {'path': 'bad'})
            reset.assert_not_called()
        self.assert_old_record_preserved()

    def test_file_import_returns_recovery_metadata_after_activation(self):
        self.record['metadata'] = {'recovery': {'kind': 'unsaved-exit', 'sourcePath': 'source.mjstudio'}}
        with patch('rms_backend.records.commands.read_record_file', return_value=self.record), \
             patch.object(service.RECORD_SESSION.dependencies, 'request_opponent_analysis'), \
             patch.object(service.RECORD_SESSION.dependencies, 'reset_runtime'), \
             patch.object(service.VIEW_BUILDER, 'build_response', side_effect=lambda _id, _cmd, extra: extra):
            result = service.STATEFUL_COMMANDS.dispatch(1, 'import_game_record', {'path': 'record'})
        self.assertEqual(result['recordMetadata'], self.record['metadata'])
        self.assertIs(service.STATE['game'], self.record['game'])

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
            for stage in ('backfill_child_comparisons', 'request_current_opponent_analysis'):
                with self.subTest(kind=kind, stage=stage), ExitStack() as stack:
                    dependency = 'backfill_child_comparisons' if stage == 'backfill_child_comparisons' else 'request_opponent_analysis'
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
