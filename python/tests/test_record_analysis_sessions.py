from concurrent.futures import Future
from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from rms_backend import service, play_prefetch_runtime
from rms_backend.record_analysis_refs import AnalysisReference
from rms_backend.record_codec_scheduler import RecordCodecScheduler
from rms_backend.record_session_storage import RecordSessionStorage
from rms_backend.record_workspace_writer import RecordWorkspaceWriter


class RecordAnalysisSessionIntegrationTests(unittest.TestCase):
    def test_real_auto_scheduler_pauses_before_model_dispatch_then_transfers_both_heads_to_storage(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            game = service.create_empty_game(333333)
            state = dict(mode='research', controlledSeat=0, pendingSeatSwitch=None, visibleHands=False)
            stack.enter_context(mock.patch.dict(service.STATE, dict(
                game=game, gameLoaded=True, opponentAnalysisEnabled=True,
                decisionRecommendationsEnabled=True, **state)))
            writer = RecordWorkspaceWriter(Path(directory) / 'auto.sqlite', 'auto', create=True)
            stack.callback(writer.close)
            scheduler = RecordCodecScheduler()
            stack.callback(scheduler.close)
            storage = RecordSessionStorage('auto', scheduler, writer)
            stack.callback(storage.results.close)
            stack.callback(storage.stop)
            writer.ready.result(3)
            storage.initialize(game, state).result(3)
            stack.enter_context(mock.patch.object(service.RECORD_SESSION, 'storage', storage))
            stack.enter_context(mock.patch.object(service.AUTO_ANALYSIS, '_storage_tickets', {}))
            stack.enter_context(mock.patch.object(service.AUTO_ANALYSIS.dependencies, 'emit'))
            stack.enter_context(mock.patch.object(service.OPPONENT_ANALYSIS, 'dependencies',
                replace(service.OPPONENT_ANALYSIS.dependencies, emit=mock.Mock())))
            stack.enter_context(mock.patch.object(service.ANALYSIS_READS, 'emit'))
            stack.enter_context(mock.patch.object(service.AUTO_ANALYSIS, 'kind_enabled', return_value=True))
            stack.enter_context(mock.patch.object(service.ACTION_RECOMMENDATIONS, 'accepts_requests', return_value=True))
            stack.enter_context(mock.patch.object(service.OPPONENT_PREDICTIONS, 'accepts_requests', return_value=True))
            deferred = stack.enter_context(mock.patch.object(service.RECORD_ANALYSIS, 'defer'))
            model_calls = []
            def submit(function, *args):
                self.assertGreaterEqual(scheduler.metrics()['backgroundReserved'], 1)
                future = Future()
                try:
                    future.set_result(function(*args))
                except Exception as error:
                    future.set_exception(error)
                return future
            def decision(*_args):
                model_calls.append('decision')
                return dict(seat=0, model='fixture', discardEntries=[])
            def opponent(_snapshot, _seat, *, context, on_complete, **_streams):
                self.assertGreaterEqual(scheduler.metrics()['backgroundReserved'], 1)
                model_calls.append('opponent')
                on_complete(dict(status='ready', context=dict(context), outputs={}))
                return True
            stack.enter_context(mock.patch.object(service.AUTO_ANALYSIS.executor, 'submit', side_effect=submit))
            stack.enter_context(mock.patch.object(service.AUTO_ANALYSIS, 'run_decision_item', side_effect=decision))
            stack.enter_context(mock.patch.object(service.OPPONENT_PREDICTIONS, 'request_background_predict', side_effect=opponent))
            try:
                with service._STATE_LOCK:
                    for kind in ('decision', 'opponent'):
                        self.assertIsNotNone(service.RECORD_ANALYSIS.reserve(game, kind, role='test'))
                    paused = service.AUTO_ANALYSIS.start()
                    self.assertEqual(paused['status'], 'running')
                    self.assertEqual(paused['failed'], 0)
                    self.assertEqual(model_calls, [])
                    self.assertEqual(deferred.call_count, 1)
                    service.RECORD_ANALYSIS.cancel(role='test')
                    deferred.call_args.args[2]()
                with storage.results.capture() as versions:
                    self.assertEqual(len(versions), 2)
                    for version in versions:
                        storage.results.portable(version)
                        version.durable.result(3)
                self.assertEqual(service.AUTO_ANALYSIS.status()['status'], 'completed')
                self.assertEqual(model_calls, ['decision', 'opponent'])
                node = game['nodes'][game['currentNodeId']]
                self.assertTrue(all(isinstance(value, AnalysisReference) for field in (
                    'analysisCache', 'opponentAnalysisCache') for value in node[field].values()))
                self.assertEqual(scheduler.metrics()['backgroundReserved'], 0)
                self.assertEqual(writer.ready.result().missing_coverage(storage.content_revision), [])
                self.assertFalse(scheduler.client.call('ping')['numpyImported'])
            finally:
                with service._STATE_LOCK:
                    service.AUTO_ANALYSIS.cancel(emit_progress=False)
                    service.RECORD_ANALYSIS.cancel()
                    service.ANALYSIS_READS.reset()
                storage.stop()
                scheduler.close()
                storage.results.close()
                writer.close()

    def test_speculative_draft_does_not_copy_or_resolve_record_analysis(self):
        class Unopened(dict):
            def __deepcopy__(self, memo):
                raise AssertionError('Speculative gameplay decoded a saved analysis')
        game = dict(gameId='g', currentNodeId='n', nodes={'n': dict(id='n', snapshot={},
                    analysisCache={'key': Unopened()}, opponentAnalysisCache={'key': Unopened()})})
        draft = play_prefetch_runtime.create_draft(game)
        self.assertEqual(draft['nodes']['n']['analysisCache'], {})
        self.assertNotIn('opponentAnalysisCache', draft['nodes']['n'])
