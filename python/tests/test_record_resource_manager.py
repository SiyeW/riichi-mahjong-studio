from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
import gc
from threading import Event
import tempfile
import unittest
from uuid import uuid4
import weakref

from rms_backend import service
from rms_backend.record_analysis_refs import AnalysisReference
from rms_backend.record_codec_scheduler import RecordCodecScheduler
from rms_backend.record_resource_manager import RecordResourceManager
from rms_backend.record_session import RecordSession
from rms_backend.record_session_storage import result_slot


@contextmanager
def resources():
    with tempfile.TemporaryDirectory() as directory:
        lane = RecordCodecScheduler()
        manager = RecordResourceManager(Path(directory) / 'workspaces', lambda: lane)
        state = dict(game=None, gameLoaded=False, mode='play', controlledSeat=0,
                     pendingSeatSwitch=None, visibleHands=False, nextGameId=1)
        dependencies = replace(service.RECORD_SESSION.dependencies,
            reset_runtime=lambda: None, advance_new_game=lambda *args: None,
            prewarm_action_engine=lambda seat: None, backfill_child_comparisons=lambda game: None,
            request_opponent_analysis=lambda *args: None, storage_changed=manager.activate)
        session = RecordSession(state, dependencies, storage_factory=manager.create)
        try:
            yield manager, lane, session, state
        finally:
            manager.shutdown()
            lane.close()


class RecordResourceManagerTests(unittest.TestCase):
    def test_idle_retirement_thread_releases_the_previous_record_graph(self):
        class TrackedGame(dict):
            pass
        with resources() as (manager, lane, session, state):
            first, second = str(uuid4()), str(uuid4())
            with manager.candidate(first):
                session.create()
            manager.confirm_activation(first)
            collected = Event()
            graph = TrackedGame(manager.resource(first).game)
            reference = weakref.ref(graph, lambda _: collected.set())
            manager.resource(first).game = graph
            del graph
            with manager.candidate(second):
                session.create()
            manager.confirm_activation(second, previous=first)
            manager.wait_released(first)
            gc.collect()
            self.assertTrue(collected.wait(.5), 'An idle collector retained its completed record graph.')
            self.assertIsNone(reference())

    def test_main_identity_is_required_and_initial_source_obligations_finish_before_activation(self):
        with resources() as (manager, lane, session, state):
            with self.assertRaisesRegex(ValueError, 'Main must allocate'):
                session.prepare_create()
            identity = str(uuid4())
            with manager.candidate(identity):
                prepared = session.prepare_create()
                self.assertFalse(state['gameLoaded'])
                self.assertEqual(prepared.storage.writer.ready.result().missing_coverage(1), [])
                self.assertIsNone(lane.client.pid)
                session.activate_load(prepared)
            confirmed = manager.confirm_activation(identity)
            self.assertEqual(confirmed['workspaceId'], identity)
            self.assertEqual(session.storage.writer.ready.result().metadata()['disposition'], 'active')

    def test_failed_candidate_preserves_current_record_and_retires_only_unactivated_resources(self):
        with resources() as (manager, lane, session, state):
            first, abandoned = str(uuid4()), str(uuid4())
            with manager.candidate(first):
                session.create()
            manager.confirm_activation(first)
            old_game, old_store = state['game'], session.storage
            with self.assertRaisesRegex(RuntimeError, 'candidate rejected'), manager.candidate(abandoned):
                session.prepare_create()
                raise RuntimeError('candidate rejected')
            self.assertIs(state['game'], old_game)
            self.assertIs(session.storage, old_store)
            outcome = manager.wait_released(abandoned)
            self.assertEqual(outcome['disposition'], 'discarded')
            self.assertIsNone(outcome['retirementError'])
            self.assertFalse(old_store.writer.closed.done())

    def test_replacement_waits_for_main_confirmation_and_export_pin_before_releasing_old_writer(self):
        with resources() as (manager, lane, session, state):
            first, second = str(uuid4()), str(uuid4())
            with manager.candidate(first):
                session.create()
            manager.confirm_activation(first)
            old = session.storage
            node = state['game']['nodes'][state['game']['currentNodeId']]
            slot = result_slot(node['id'], 'analysisCache', 'test')
            identity = old.accept_analysis(old.reserve_analysis(), slot, {'seat': 0, 'discardEntries': []},
                                           epoch=0, kind='decision', seat=0)
            node.setdefault('analysisCache', {})['test'] = AnalysisReference(old.results, identity)
            with old.results.capture() as snapshot:
                with manager.candidate(second):
                    session.create()
                self.assertFalse(old.writer.closed.done())
                manager.confirm_activation(second, previous=first)
                self.assertFalse(old.writer.closed.done())
                self.assertGreater(old.results.portable(snapshot[0]).length, 0)
            outcome = manager.wait_released(first)
            self.assertIsNone(outcome['retirementError'])
            self.assertTrue(old.writer.closed.done())
            self.assertFalse(session.storage.writer.closed.done())
