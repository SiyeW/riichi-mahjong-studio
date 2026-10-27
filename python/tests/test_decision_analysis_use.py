from contextlib import ExitStack
from pathlib import Path
from threading import Event, Thread
import tempfile
import unittest
from unittest import mock

from rms_backend import service
from rms_backend.records.analysis_values import AnalysisReadError
from rms_backend.records.codec_scheduler import RecordCodecScheduler
from rms_backend.records.session_storage import RecordSessionStorage
from rms_backend.records.workspace_writer import RecordWorkspaceWriter


class DecisionAnalysisUseTests(unittest.TestCase):
    def test_policy_read_wait_releases_game_lock_and_a_changed_seat_rejects_the_action(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            game = service.create_empty_game(333333)
            state = dict(mode='play', controlledSeat=0, pendingSeatSwitch=None, visibleHands=False)
            stack.enter_context(mock.patch.dict(service.STATE, dict(game=game, gameLoaded=True,
                decisionRecommendationsEnabled=True, opponentAnalysisEnabled=False, **state)))
            writer = RecordWorkspaceWriter(Path(directory) / 'scope.sqlite', 'scope', create=True)
            stack.callback(writer.close)
            lane = RecordCodecScheduler()
            stack.callback(lane.close)
            storage = RecordSessionStorage('scope', lane, writer)
            stack.callback(storage.results.close)
            stack.callback(storage.stop)
            writer.ready.result(3)
            node = game['nodes'][game['currentNodeId']]
            key = service.DECISION_ANALYSIS.cache_key(node['snapshot'])
            node['analysisCache'][key] = dict(seat=0, discardEntries=[])
            storage.initialize(game, state).result(3)
            storage.adopt_analyses(game)
            storage.wait_authored(storage.cutoff())
            stack.enter_context(mock.patch.object(service.RECORD_SESSION, 'storage', storage))
            handler = stack.enter_context(mock.patch.object(service.GAMEPLAY_COMMANDS, 'submit'))
            entered, release, errors = Event(), Event(), []
            codec = lane.codec
            def held(namespace, schemas, operation, **payload):
                if operation == 'input':
                    entered.set()
                    if not release.wait(5):
                        raise TimeoutError('Fixture policy was not released')
                return codec(namespace, schemas, operation, **payload)
            stack.enter_context(mock.patch.object(lane, 'codec', side_effect=held))
            def action():
                try:
                    service.STATEFUL_COMMANDS.dispatch('action', 'submit_user_action', dict(type='none'))
                except Exception as error:
                    errors.append(error)
            thread = Thread(target=action)
            thread.start()
            try:
                self.assertTrue(entered.wait(2))
                acquired = service._STATE_LOCK.acquire(blocking=False)
                self.assertTrue(acquired, 'A policy body read held the game lock')
                if acquired:
                    service.STATE['controlledSeat'] = 1
                    service._STATE_LOCK.release()
                release.set()
                thread.join(5)
                self.assertFalse(thread.is_alive())
                self.assertEqual(len(errors), 1)
                self.assertIsInstance(errors[0], ValueError)
                handler.assert_not_called()
                self.assertEqual(storage.content_revision, 1)
                self.assertTrue(all(version.pins == 0 for version in storage.results._versions.values()))
            finally:
                release.set()
                thread.join(5)

    def test_actual_review_uses_cold_policy_with_a_tiny_cache_and_no_encoding_capacity(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            game = service.create_empty_game(333333)
            state = dict(mode='play', controlledSeat=0, pendingSeatSwitch=None, visibleHands=False)
            stack.enter_context(mock.patch.dict(service.STATE, dict(game=game, gameLoaded=True,
                decisionRecommendationsEnabled=True, opponentAnalysisEnabled=False, **state)))
            writer = RecordWorkspaceWriter(Path(directory) / 'review.sqlite', 'review', create=True)
            stack.callback(writer.close)
            lane = RecordCodecScheduler()
            stack.callback(lane.close)
            storage = RecordSessionStorage('review', lane, writer)
            stack.callback(storage.results.close)
            stack.callback(storage.stop)
            writer.ready.result(3)
            node = game['nodes'][game['currentNodeId']]
            tiles = sorted(set(node['snapshot']['hands'][0]))
            chosen = tiles[-1]
            key = service.DECISION_ANALYSIS.cache_key(node['snapshot'])
            policy = dict(seat=0, model='saved fixture', discardEntries=[dict(
                pai=tile, fromDrawn=False, probability=.5 if index == 0 else .05,
                bar=1.0 if index == 0 else .1, value=1.0 if index == 0 else .1,
                isBest=index == 0, rank=index + 1) for index, tile in enumerate(tiles)])
            node['analysisCache'][key] = policy
            storage.initialize(game, state).result(3)
            storage.adopt_analyses(game)
            storage.wait_authored(storage.cutoff())
            storage.results.cache.set_budget(1)
            stack.enter_context(mock.patch.object(service.RECORD_SESSION, 'storage', storage))
            stack.enter_context(mock.patch.object(service.ENGINE_MANAGEMENT, 'training_config', return_value={'mode': 'always_review'}))
            stack.enter_context(mock.patch.object(service.PLAY_PREFETCH, 'start', return_value={}))
            stack.enter_context(mock.patch.object(service.ANALYSIS_READS, 'emit'))
            model = stack.enter_context(mock.patch.object(service.ACTION_RECOMMENDATIONS, 'analyze_candidates'))
            blocked = lane.reserve(foreground=True)
            stack.callback(blocked.release)
            operations = []
            codec = lane.codec
            def track(namespace, schemas, operation, **payload):
                operations.append(operation)
                return codec(namespace, schemas, operation, **payload)
            stack.enter_context(mock.patch.object(lane, 'codec', side_effect=track))
            try:
                response = service.STATEFUL_COMMANDS.dispatch('review', 'submit_user_action',
                    dict(type='dahai', pai=chosen, fromDrawn=False))
                pending = response['view']['pendingReview']
                self.assertIsNotNone(pending)
                self.assertEqual(pending['comparison']['chosenKey'], chosen)
                self.assertEqual(pending['comparison']['chosenProbability'], .05)
                self.assertEqual(response['view']['analysis'], policy)
                self.assertEqual(game['currentNodeId'], node['id'])
                self.assertEqual(operations, ['input'])
                self.assertIsNone(node['analysisCache'][key].ready_value())
                self.assertEqual(lane.metrics()['foregroundReserved'], 1)
                model.assert_not_called()
                self.assertTrue(all(version.pins == 0 for version in storage.results._versions.values()))
                storage.wait_authored(storage.cutoff())
                self.assertIsNotNone(writer.ready.result().metadata()['cursor']['state']['pendingReview'])
                storage.results._versions[node['analysisCache'][key].identity].error = AnalysisReadError('unavailable old policy')
                confirmed = service.STATEFUL_COMMANDS.dispatch('confirm', 'confirm_pending_review', {})
                self.assertIsNone(confirmed['view']['pendingReview'])
                self.assertNotEqual(game['currentNodeId'], node['id'])
                self.assertEqual(operations, ['input'], 'Confirming an already compared action reread the old policy')
            finally:
                with service._STATE_LOCK:
                    service.ANALYSIS_READS.reset()
                    service.RECORD_ANALYSIS.cancel()

