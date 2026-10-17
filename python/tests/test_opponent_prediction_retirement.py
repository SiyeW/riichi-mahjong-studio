"""Real queue + record admission + durable result, not just idle flags."""

import time
import unittest
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch

from tests.test_record_analysis_access import environment
from rms_backend.analysis_read_presenter import AnalysisReadPresenter
from rms_backend.opponent_analysis_session import OpponentAnalysisDependencies, OpponentAnalysisSession
from rms_backend.opponent_prediction_activity import OpponentPredictionActivity
from rms_backend.opponent_prediction_requests import OpponentPredictionRequests
from rms_backend.records.view_context import RecordViewContext


def eventually(predicate):
    limit = time.monotonic() + 5
    while not predicate():
        if time.monotonic() >= limit:
            raise AssertionError('Prediction lifecycle did not settle')
        time.sleep(.005)


class PredictionRetirementTests(unittest.TestCase):
    def setup_session(self, env, execute=None):
        storage, writer, lane, game, state, epochs, access = env
        activity, delivered = OpponentPredictionActivity(), Event()
        activity.reset(unloaded=False)
        visits = RecordViewContext(state, lambda: (0, 0))
        presenter = AnalysisReadPresenter(access.state_lock, visits.current, lambda _: delivered.set())
        def predict(request, _):
            return {'status': 'ready', 'context': request['context'],
                    'outputs': {'extension': {'node': request['context']['nodeId']}}}, 1
        with patch('rms_backend.opponent_prediction_requests.threading.Thread.start'):
            queue = OpponentPredictionRequests(activity=activity, supported_input_modes=lambda: ('public',),
                is_initializing=lambda: False, prewarm=lambda: True, execute=execute or predict,
                activity_error=activity.error, format_error=lambda prefix, error: str(error))
        predictions = SimpleNamespace(supported_input_modes=lambda: ('public',), accepts_requests=activity.accepts_requests,
            has_request=queue.has_request, set_latest_context=queue.set_latest_context,
            request_predict=lambda snapshot, seat, visible, **kwargs: queue.request_foreground(
                snapshot, seat, include_ground_truth=True, **kwargs),
            activity_error=activity.error, get_latest=queue.get_latest)
        bundle = dict(events=[], prefixHashes=[], eventHash=0)
        session = OpponentAnalysisSession(state, access.state_lock, predictions,
            SimpleNamespace(opponent_cache_epoch=0, opponent_source=lambda **_: {'id': 'source'}),
            OpponentAnalysisDependencies(build_mjai_stream_bundle=lambda *_, **__: bundle,
                play_prefetch_owns=lambda _: False, auto_analysis_owns=lambda *_: False,
                set_timeline_cached=lambda *_: None, get_auto_analysis_status=lambda **_: {},
                emit=lambda _: None, read_presenter=presenter, record_access=access))
        def close():
            queue.shutdown()
            if queue._worker.is_alive():
                queue._worker.join(3)
            presenter.close()
        return session, queue, activity, delivered, close, predict

    def assert_next_completes(self, env, session, queue):
        storage, writer, lane, game, state, epochs, access = env
        with access.state_lock:
            self.assertTrue(session.request_current())
        if queue._worker.ident is None:
            queue._worker.start()
        eventually(lambda: not queue.has_work() and lane.metrics()['foregroundReserved'] == 0)
        with access.state_lock:
            reference = game['nodes'][game['currentNodeId']]['opponentAnalysisCache'][session.cache_key()]
        eventually(lambda: reference.ready_value() is not None)
        self.assertEqual(reference.ready_value()['outputs']['extension']['node'], game['currentNodeId'])
        # Cancelling model ownership after storage transfer cannot delete facts.
        queue.cancel_all()
        self.assertIs(game['nodes'][game['currentNodeId']]['opponentAnalysisCache'][session.cache_key()], reference)
        self.assertIsNotNone(access.reserve(game, 'opponent', foreground=True))
        access.cancel()

    def test_each_pending_retirement_returns_capacity_and_next_prediction_persists(self):
        for action in ('cancel_pending', 'cancel_all', 'new_context'):
            with self.subTest(action=action), environment() as env:
                session, queue, activity, delivered, close, predict = self.setup_session(env)
                try:
                    self.assertTrue(session.request_current())
                    self.assertEqual(env[2].metrics()['foregroundReserved'], 1)
                    if action == 'new_context':
                        queue.set_latest_context({'nodeId': 'different'})
                    else:
                        getattr(queue, action)()
                    self.assertEqual(env[2].metrics()['foregroundReserved'], 0)
                    self.assert_next_completes(env, session, queue)
                finally:
                    close()

    def test_active_cancel_supersession_error_and_a_b_a_do_not_block_next_result(self):
        for action in ('cancel_pending', 'cancel_all', 'supersede', 'late_error', 'a_b_a'):
            with self.subTest(action=action), environment() as env:
                entered, release = Event(), Event()
                calls = []
                def execute(request, initializing):
                    calls.append(request['context']['nodeId'])
                    if len(calls) == 1:
                        entered.set()
                        if not release.wait(3): raise RuntimeError('controlled execution deadline')
                        if action == 'late_error': raise RuntimeError('obsolete engine failure')
                    return {'status': 'ready', 'context': request['context'],
                            'outputs': {'extension': {'node': request['context']['nodeId'], 'attempt': len(calls)}}}, 1
                session, queue, activity, delivered, close, predict = self.setup_session(env, execute)
                try:
                    self.assertTrue(session.request_current())
                    queue._worker.start()
                    self.assertTrue(entered.wait(2))
                    old = session.current_context()
                    if action.startswith('cancel'):
                        getattr(queue, action)()
                    else:
                        queue.set_latest_context({**old, 'nodeId': 'new'})
                    if action == 'a_b_a':
                        queue.set_latest_context(old)
                    self.assertFalse(queue.has_request(old), 'a cancelled physical task is not a reusable active request')
                    self.assertEqual(env[2].metrics()['foregroundReserved'], 0)
                    release.set()
                    eventually(lambda: not queue.has_work())
                    self.assertIsNone(activity.error(), 'obsolete errors must not poison the new task')
                    self.assert_next_completes(env, session, queue)
                    self.assertEqual(len(calls), 2)
                    reference = env[3]['nodes']['n']['opponentAnalysisCache'][session.cache_key()]
                    self.assertEqual(reference.ready_value()['outputs']['extension']['attempt'], 2)
                finally:
                    release.set()
                    close()

    def test_shutdown_and_unloaded_rejection_return_capacity_without_restarting_worker(self):
        for action in ('shutdown', 'unloaded'):
            with self.subTest(action=action), environment() as env:
                session, queue, activity, delivered, close, predict = self.setup_session(env)
                try:
                    self.assertTrue(session.request_current())
                    if action == 'shutdown':
                        queue.shutdown()
                    else:
                        queue.cancel_all()
                        activity.reset(unloaded=True)
                    self.assertEqual(env[2].metrics()['foregroundReserved'], 0)
                    ticket = env[6].reserve(env[3], 'opponent', foreground=True)
                    queue.request_foreground({}, 0, input_mode='public', context={}, on_complete=None,
                        on_discard=lambda: env[6].retire(ticket), mjai_events=None, mjai_prefix_hashes=None,
                        mjai_events_hash=None, target_mjai_events=None, target_mjai_prefix_hashes=None,
                        target_mjai_events_hash=None, include_ground_truth=False)
                    self.assertEqual(env[2].metrics()['foregroundReserved'], 0)
                finally:
                    close()

    def test_pre_execution_supersession_and_prewarm_failure_allow_followup(self):
        for phase in ('before_execute', 'prewarm_failure'):
            with self.subTest(phase=phase), environment() as env:
                entered, release = Event(), Event()
                session, queue, activity, delivered, close, predict = self.setup_session(env)
                try:
                    self.assertTrue(session.request_current())
                    def initializing():
                        entered.set()
                        if not release.wait(3): raise RuntimeError('initialization deadline')
                        return phase == 'prewarm_failure'
                    queue._is_initializing = initializing
                    queue._prewarm = lambda: False
                    with patch.object(queue, '_execute', wraps=predict) as executed:
                        queue._worker.start()
                        self.assertTrue(entered.wait(2))
                        if phase == 'before_execute':
                            queue.set_latest_context({'nodeId': 'new'})
                        release.set()
                        eventually(lambda: not queue.has_work())
                        executed.assert_not_called()
                    self.assertEqual(env[2].metrics()['foregroundReserved'], 0)
                    queue._is_initializing = lambda: False
                    self.assert_next_completes(env, session, queue)
                finally:
                    release.set()
                    close()

    def test_callback_failure_releases_capacity_and_worker_keeps_serving(self):
        with environment() as env:
            session, queue, activity, delivered, close, predict = self.setup_session(env)
            try:
                with patch.object(session, 'cache_result', side_effect=RuntimeError('consumer failed')):
                    self.assertTrue(session.request_current())
                    queue._worker.start()
                    eventually(lambda: not queue.has_work())
                self.assertEqual(env[2].metrics()['foregroundReserved'], 0)
                self.assert_next_completes(env, session, queue)
            finally:
                close()

    def test_many_cancelled_visits_do_not_accumulate_capacity(self):
        with environment() as env:
            session, queue, activity, delivered, close, predict = self.setup_session(env)
            try:
                for _ in range(100):
                    self.assertTrue(session.request_current())
                    queue.cancel_pending()
                    self.assertEqual(env[2].metrics()['foregroundReserved'], 0)
                self.assert_next_completes(env, session, queue)
            finally:
                close()

    def test_delivered_background_result_keeps_its_ticket_until_actual_storage_transfer(self):
        with environment() as env:
            storage, writer, lane, game, state, epochs, access = env
            session, queue, activity, delivered, close, predict = self.setup_session(env)
            held = []
            try:
                ticket = access.reserve(game, 'opponent', role='prefetch')
                self.assertTrue(queue.request_background({}, 0, input_mode='public', context=session.current_context(),
                    on_complete=held.append, on_discard=lambda: access.retire(ticket), mjai_events=None,
                    mjai_prefix_hashes=None, mjai_events_hash=None, target_mjai_events=None,
                    target_mjai_prefix_hashes=None, target_mjai_events_hash=None, include_ground_truth=False))
                queue._worker.start()
                eventually(lambda: bool(held) and not queue.has_work())
                queue.cancel_all()
                self.assertFalse(ticket.cancelled)
                self.assertEqual(lane.metrics()['backgroundReserved'], 1)
                with access.state_lock:
                    reference = access.store(ticket, game, game['nodes']['n'], session.cache_key(), held[0], {'id': 'source'})
                self.assertIsNotNone(reference)
                eventually(lambda: lane.metrics()['backgroundReserved'] == 0)
                self.assertEqual(reference.ready_value()['outputs']['extension']['node'], 'n')
            finally:
                close()
