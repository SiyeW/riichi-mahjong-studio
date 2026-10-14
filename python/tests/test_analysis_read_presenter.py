from contextlib import contextmanager
from pathlib import Path
from threading import Event, RLock, Thread
from types import SimpleNamespace
import tempfile
import unittest

from rms_backend.analysis_read_presenter import AnalysisReadPresenter
from rms_backend.opponent_analysis_session import OpponentAnalysisDependencies, OpponentAnalysisSession
from rms_backend.record_analysis_refs import AnalysisReference
from rms_backend.record_codec_scheduler import RecordCodecScheduler
from rms_backend.record_result_store import RecordResultStore
from rms_backend.record_view_context import RecordViewContext
from rms_backend.record_workspace_writer import RecordWorkspaceWriter


@contextmanager
def environment():
    with tempfile.TemporaryDirectory() as directory:
        writer = RecordWorkspaceWriter(Path(directory) / 'workspace.sqlite', 'read-test', create=True)
        lane = RecordCodecScheduler()
        store = RecordResultStore('read-test', lane, writer, budget=1)
        lock, emitted, delivered = RLock(), [], Event()
        state = dict(gameLoaded=True, game=dict(gameId='game', currentNodeId='A'),
                     mode='research', controlledSeat=0, visibleHands=False)
        visits = RecordViewContext(state, lambda: (1, 1))
        def emit(event):
            emitted.append(event)
            delivered.set()
        presenter = AnalysisReadPresenter(lock, visits.current, emit)
        try:
            writer.ready.result(3)
            yield store, lane, writer, lock, state, visits, presenter, emitted, delivered
        finally:
            presenter.close()
            store.close()
            lane.close()
            writer.close()


def stored(store, writer, value):
    identity = store.accept('A/opponent', value, revision=1, epoch=0,
                            reservation=store.reserve(), kind='opponent')
    version = store._versions[identity]
    version.pending.result(5)
    version.durable.result(5)
    return AnalysisReference(store, identity)


class AnalysisReadPresenterTests(unittest.TestCase):
    def test_temporary_capacity_pressure_retries_one_current_read_without_starting_inference(self):
        with environment() as (store, lane, writer, lock, state, visits, presenter, events, delivered):
            value = dict(status='ready', outputs={'extension': [0, .5, 1]})
            identity = store.register('saved', fields={'status': [True, 'ready'], 'outputs': [False, None]}, raw=value)
            reference = AnalysisReference(store, identity)
            blocked = lane.reserve(foreground=True)
            try:
                with lock:
                    for _ in range(100):
                        self.assertIsNone(presenter.read(reference, kind='opponent', context=dict(cacheEpoch=1)))
                    self.assertEqual(len(presenter._retry_timers), 1)
                    self.assertIsNone(lane.client.pid)
                blocked.release()
                self.assertTrue(delivered.wait(5))
                self.assertEqual(events[0]['opponentAnalysis']['outputs'], value['outputs'])
                self.assertEqual(presenter._retry_timers, {})
            finally:
                blocked.release()

    def test_cold_read_never_blocks_game_lock_and_delivers_an_oversize_body(self):
        with environment() as (store, lane, writer, lock, state, visits, presenter, events, delivered):
            original = dict(status='ready', outputs={'extension': [0, .25, 1]})
            reference = stored(store, writer, original)
            self.assertIsNone(reference.ready_value())
            entered, release, gameplay = Event(), Event(), Event()
            held = lane.submit_read('held', lambda _: (entered.set(), release.wait(5)))
            self.assertTrue(entered.wait(2))
            try:
                with lock:
                    token = visits.current()
                    result = presenter.read(reference, kind='opponent', context=dict(nodeId='A', cacheEpoch=1))
                self.assertIsNone(result)
                def mutate():
                    with lock:
                        gameplay.set()
                thread = Thread(target=mutate)
                thread.start()
                self.assertTrue(gameplay.wait(1), 'A cold analysis held the game-state lock')
                thread.join(1)
                release.set()
                held.result(3)
                self.assertTrue(delivered.wait(5))
                self.assertEqual(events[0]['viewToken'], token)
                self.assertEqual(events[0]['opponentAnalysis']['outputs'], original['outputs'])
                self.assertIsNone(reference.ready_value(), 'Presentation must not require a cache budget floor')
                self.assertEqual(presenter._observed, {}, 'Completed futures must not mirror the decoded cache')
            finally:
                release.set()

    def test_a_reusable_body_can_serve_new_aba_visit_but_never_publish_to_old_visit(self):
        with environment() as (store, lane, writer, lock, state, visits, presenter, events, delivered):
            reference = stored(store, writer, dict(status='ready', outputs={'extension': [.5, .5]}))
            entered, release = Event(), Event()
            held = lane.submit_read('held', lambda _: (entered.set(), release.wait(5)))
            self.assertTrue(entered.wait(2))
            try:
                with lock:
                    presenter.read(reference, kind='opponent', context=dict(cacheEpoch=1))
                    first = visits.current()
                    state['game']['currentNodeId'] = 'B'
                    visits.current()
                    state['game']['currentNodeId'] = 'A'
                    visits.begin_visit(3)
                    latest = visits.current()
                    presenter.read(reference, kind='opponent', context=dict(cacheEpoch=1))
                release.set()
                held.result(3)
                self.assertTrue(delivered.wait(5))
                self.assertNotEqual(first, latest)
                self.assertEqual([event['viewToken'] for event in events], [latest])
            finally:
                release.set()

    def test_terminal_display_reads_predecessor_without_inference_or_clearing_data(self):
        with environment() as (store, lane, writer, lock, state, visits, presenter, events, delivered):
            reference = stored(store, writer, dict(status='ready', outputs={'extension': [.25, .75]}))
            state.update(opponentAnalysisEnabled=True, visibleHands=True)
            manager = SimpleNamespace(opponent_cache_epoch=1, opponent_source=lambda **_: {'id': 'source'})
            predictions = SimpleNamespace(supported_input_modes=lambda: ['public'])
            session = OpponentAnalysisSession(state, lock, predictions, manager, OpponentAnalysisDependencies(
                build_mjai_stream_bundle=lambda *_, **__: self.fail('Terminal inference attempted'),
                play_prefetch_owns=lambda _: False, auto_analysis_owns=lambda *_: False,
                set_timeline_cached=lambda *_: None, get_auto_analysis_status=lambda **_: {},
                emit=lambda _: None, read_presenter=presenter))
            key = session.build_cache_key(0, 'full-information')
            state['game'].update(currentNodeId='T', nodes={
                'A': dict(id='A', type='action', snapshot=dict(phase='discard', roundIndex=0, honba=0),
                          opponentAnalysisCache={key: reference}),
                'T': dict(id='T', type='action', parentId='A', snapshot=dict(phase='game_end', roundIndex=0, honba=0)),
            })
            with lock:
                context = session.current_context()
                self.assertEqual(context['inputMode'], 'full-information')
                self.assertFalse(session.request_current())
                self.assertEqual(session.current()['status'], 'loading')
            self.assertTrue(delivered.wait(5))
            self.assertEqual(events[0]['nodeId'], 'T')
            self.assertEqual(events[0]['opponentAnalysis']['status'], 'terminal')
            self.assertEqual(events[0]['opponentAnalysis']['context']['nodeId'], 'T')
            self.assertEqual(store.metrics()['entries'], 0)
