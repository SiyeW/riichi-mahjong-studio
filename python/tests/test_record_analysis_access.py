from contextlib import contextmanager
from pathlib import Path
from threading import Event, RLock
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from rms_backend.analysis_cache import decision_cache_key
from rms_backend.records.analysis_access import RecordAnalysisAccess
from rms_backend.records.codec_scheduler import RecordCodecScheduler
from rms_backend.records.session_storage import RecordSessionStorage, result_slot
from rms_backend.records.workspace_writer import RecordWorkspaceWriter
from rms_backend.analysis_read_presenter import AnalysisReadPresenter
from rms_backend.opponent_analysis_session import OpponentAnalysisSession, OpponentAnalysisDependencies
from rms_backend.records.view_context import RecordViewContext


@contextmanager
def environment():
    with tempfile.TemporaryDirectory() as directory:
        writer = RecordWorkspaceWriter(Path(directory) / 'model.sqlite', 'model', create=True)
        lane = RecordCodecScheduler()
        storage = RecordSessionStorage('model', lane, writer)
        game = dict(gameId='g', currentNodeId='n', nodes={'n': dict(id='n', snapshot={}, children=[])})
        state = dict(game=game, gameLoaded=True, mode='research', controlledSeat=0,
                     visibleHands=False, opponentAnalysisEnabled=True)
        epochs, lock = {'decision': 0, 'opponent': 0}, RLock()
        access = RecordAnalysisAccess(state, lock, lambda: storage, epochs.__getitem__)
        try:
            writer.ready.result(3)
            storage.initialize(game, dict(mode='research', controlledSeat=0, visibleHands=False)).result(3)
            yield storage, writer, lane, game, state, epochs, access
        finally:
            with lock:
                access.cancel()
            storage.stop()
            lane.close()
            storage.results.close()
            writer.close()


class RecordAnalysisAccessTests(unittest.TestCase):
    def test_actual_opponent_session_reserves_before_model_and_publishes_canonical_stored_facts(self):
        with environment() as (storage, writer, lane, game, state, epochs, access):
            lock, events, delivered, requests = access.state_lock, [], Event(), []
            visits = RecordViewContext(state, lambda: (0, 0))
            def emit(event):
                events.append(event)
                delivered.set()
            presenter = AnalysisReadPresenter(lock, visits.current, emit)
            def request(*args, **kwargs):
                self.assertEqual(lane.metrics()['foregroundReserved'], 1)
                requests.append(kwargs)
            predictions = SimpleNamespace(supported_input_modes=lambda: ['public'], accepts_requests=lambda: True,
                has_request=lambda _: False, set_latest_context=lambda _: None, request_predict=request,
                activity_error=lambda: None, get_latest=lambda: self.fail('Owned presentation copied the raw model latest'))
            manager = SimpleNamespace(opponent_cache_epoch=0, opponent_source=lambda **_: {'id': 'source'})
            bundle = dict(events=[], prefixHashes=[], eventHash=0)
            session = OpponentAnalysisSession(state, lock, predictions, manager, OpponentAnalysisDependencies(
                build_mjai_stream_bundle=lambda *_, **__: bundle, play_prefetch_owns=lambda _: False,
                auto_analysis_owns=lambda *_: False, set_timeline_cached=lambda *_: None,
                get_auto_analysis_status=lambda **_: {},
                emit=lambda event: emit(event) if event['type'] == 'opponent_analysis_ready' else None,
                read_presenter=presenter, record_access=access))
            try:
                with lock:
                    self.assertEqual(session.current()['status'], 'loading')
                    self.assertEqual(len(requests), 1)
                    self.assertTrue(requests[0]['on_complete'](dict(status='ready', context=requests[0]['context'],
                        outputs={'extension': {'values': [0, .123456789, 1]}})))
                self.assertTrue(delivered.wait(5))
                with lock:
                    current = session.current()
                    reference = game['nodes']['n']['opponentAnalysisCache'][session.cache_key()]
                self.assertEqual(current['outputs'], events[0]['opponentAnalysis']['outputs'])
                self.assertEqual(current['outputs']['extension']['values'], [0, .123456789, 1])
                self.assertEqual(events[0]['viewToken'], visits.current())
                self.assertEqual(current['outputs'], reference.ready_value()['outputs'])
                self.assertEqual(len(requests), 1, 'A disk-present/current result dispatched duplicate inference')
                self.assertFalse(lane.client.call('ping')['numpyImported'])
            finally:
                presenter.close()

    def test_capacity_is_reserved_before_dispatch_and_cancellation_never_releases_transferred_data(self):
        with environment() as (storage, writer, lane, game, state, epochs, access):
            first = access.reserve(game, 'decision', role='auto')
            second = access.reserve(game, 'opponent', role='prefetch')
            foreground = access.reserve(game, 'decision', foreground=True)
            self.assertIsNone(access.reserve(game, 'opponent', role='auto'))
            self.assertIsNone(access.reserve(game, 'decision', foreground=True))
            access.cancel(first)
            access.cancel(second)
            entered, release = Event(), Event()
            held = lane.submit_read('held', lambda _: (entered.set(), release.wait(5)))
            self.assertTrue(entered.wait(2))
            try:
                source = {'id': 'source'}
                key = decision_cache_key(0, 'discard', source)
                reference = access.store(foreground, game, game['nodes']['n'], key,
                                         {'seat': 0, 'discardEntries': []}, source)
                self.assertIsNotNone(reference)
                access.cancel()
                self.assertEqual(lane.metrics()['foregroundReserved'], 1)
                release.set()
                held.result(3)
                with storage.results.capture() as versions:
                    storage.results.portable(versions[0])
                    versions[0].durable.result(3)
                self.assertEqual(lane.metrics()['foregroundReserved'], 0)
            finally:
                release.set()

    def test_stale_epoch_deleted_node_or_replaced_record_cannot_accept_inference(self):
        for fault in ('epoch', 'deleted', 'replaced'):
            with self.subTest(fault=fault), environment() as (storage, writer, lane, game, state, epochs, access):
                ticket = access.reserve(game, 'decision', foreground=True)
                node = game['nodes']['n']
                if fault == 'epoch':
                    epochs['decision'] += 1
                elif fault == 'deleted':
                    del game['nodes']['n']
                else:
                    state['game'] = dict(game)
                source = {'id': 'source'}
                self.assertIsNone(access.store(ticket, game, node, decision_cache_key(0, 'discard', source),
                                               {'seat': 0}, source))
                self.assertEqual(lane.metrics()['foregroundReserved'], 0)
                self.assertEqual(storage.content_revision, 1)

    def test_failed_acceptance_retry_preserves_source_provenance_and_superseded_slot_tombstones(self):
        with environment() as (storage, writer, lane, game, state, epochs, access):
            old_source, new_source = {'id': 'old'}, {'id': 'new', 'displayName': 'New source'}
            old_key = decision_cache_key(0, 'discard', old_source)
            new_key = decision_cache_key(0, 'discard', new_source)
            game['nodes']['n']['analysisCache'] = {old_key: {'seat': 0, 'discardEntries': []}}
            storage.adopt_analyses(game)
            storage.wait_authored(storage.cutoff())
            ticket = access.reserve(game, 'decision', foreground=True)
            submit = writer.submit
            def reject(operation, *args, **kwargs):
                if operation == 'accept_result':
                    raise OSError('acceptance write failed')
                return submit(operation, *args, **kwargs)
            with patch.object(writer, 'submit', side_effect=reject):
                reference = access.store(ticket, game, game['nodes']['n'], new_key,
                                         {'seat': 0, 'discardEntries': [], 'engineFingerprint': 'fingerprint'}, new_source)
                with storage.results.capture() as versions:
                    storage.results.portable(versions[0])
                    with self.assertRaisesRegex(ValueError, 'Unknown accepted'):
                        versions[0].durable.result(3)
            storage.results.retry_persistence(reference.identity).result(3)
            index = writer.ready.result().restore_index()
            slots = {row[0]: row for row in index['slots']}
            self.assertIsNone(slots[result_slot('n', 'analysisCache', old_key)][3])
            self.assertEqual(slots[result_slot('n', 'analysisCache', new_key)][3], reference.identity)
            self.assertEqual(index['metadata']['game:analysisSources']['new']['engineFingerprint'], 'fingerprint')
            self.assertEqual(set(game['nodes']['n']['analysisCache']), {new_key})
