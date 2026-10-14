from contextlib import contextmanager
from pathlib import Path
import tempfile
import threading
import unittest

from rms_backend.record_codec_scheduler import RecordCodecScheduler
from rms_backend.record_session_storage import RecordSessionStorage
from rms_backend.record_workspace_writer import RecordWorkspaceWriter


@contextmanager
def session_storage():
    with tempfile.TemporaryDirectory() as directory:
        writer = RecordWorkspaceWriter(Path(directory) / 'workspace.sqlite', 'session', create=True)
        scheduler = RecordCodecScheduler()
        session = RecordSessionStorage('session', scheduler, writer, coalesce_seconds=10)
        try:
            writer.ready.result(3)
            game = {'gameId': 'test', 'currentNodeId': 'n', 'nodes': {
                'n': {'snapshot': {'hand': ['5mr'], 'history': []}, 'children': [], 'comment': 'old'}},
                'rootNodeId': 'n'}
            session.initialize(game, {'controlledSeat': 0, 'mode': 'research'}).result(3)
            yield session, writer, scheduler
        finally:
            session.stop()
            scheduler.close()
            writer.close()


class RecordSessionStorageTests(unittest.TestCase):
    def test_comment_packets_are_coalesced_without_rewriting_snapshots(self):
        with session_storage() as (session, writer, _):
            workspace = writer.ready.result()
            before = workspace.restore_index()['nodes']['n']['snapshot']
            revision, first = session.accept_authored(attributes={'n': {'children': [], 'comment': 'first'}})
            deadline = session._timer
            _, second = session.accept_authored(attributes={'n': {'children': [], 'comment': 'second'}})
            self.assertIs(session._timer, deadline)
            self.assertFalse(first.cancel())
            self.assertEqual(workspace.restore_index()['nodes']['n']['attributes']['comment'], 'old')
            cutoff = session.cutoff()
            session.wait_authored(cutoff)
            index = workspace.restore_index()
            self.assertEqual(index['nodes']['n']['snapshot'], before)
            self.assertEqual(index['nodes']['n']['attributes']['comment'], 'second')
            self.assertTrue(first.done() and second.done())
            self.assertEqual(workspace.missing_coverage(cutoff.content), [])

    def test_freeze_rejects_inflight_old_results_even_after_cancel_and_resume(self):
        with session_storage() as (session, _writer, _):
            old = session.reserve_analysis()
            close = session.cutoff(freeze=True)
            self.assertIsNone(session.reserve_analysis())
            self.assertTrue(session.cancel_close(close))
            self.assertFalse(session.cancel_close(close))
            self.assertIsNone(session.accept_analysis(old, 'slot', {'probability': .25}, epoch=0, kind='decision'))
            self.assertEqual(session.content_revision, 1)
            new = session.reserve_analysis()
            identity = session.accept_analysis(new, 'slot', {'probability': .5}, epoch=0, kind='decision')
            self.assertEqual(session.content_revision, 2)
            with session.results.capture() as versions:
                session.results.portable(versions[0])
                versions[0].durable.result(3)
            self.assertEqual(session.results.slot('slot'), identity)

    def test_content_and_cursor_are_independent_and_old_barrier_never_waits_for_new_cursor(self):
        with session_storage() as (session, writer, _):
            workspace = writer.ready.result()
            session.move_cursor({'currentNodeId': 'earlier'})
            cutoff = session.cutoff()
            started, release = threading.Event(), threading.Event()
            original = workspace.cursor
            def held(sequence, state):
                if sequence == cutoff.cursor + 1:
                    started.set()
                    release.wait(3)
                return original(sequence, state)
            workspace.cursor = held
            try:
                session.move_cursor({'currentNodeId': 'later'})
                self.assertTrue(started.wait(2))
                session.wait_authored(cutoff)
                self.assertEqual(session.content_revision, cutoff.content)
                self.assertEqual(session.cursor_sequence, cutoff.cursor + 1)
            finally:
                release.set()
            session.wait_authored(session.cutoff())
            self.assertEqual(workspace.metadata()['cursor']['state']['currentNodeId'], 'later')

    def test_authored_failure_retains_changed_packets_for_explicit_retry(self):
        with session_storage() as (session, writer, _):
            workspace = writer.ready.result()
            original = workspace.authored_batch
            def failed(_changes):
                raise OSError('Injected durable write failure')
            workspace.authored_batch = failed
            _, pending = session.accept_authored(attributes={'n': {'comment': 'must survive', 'children': []}})
            session.flush_authored()
            with self.assertRaisesRegex(OSError, 'failure'):
                pending.result(3)
            self.assertIsNone(session.reserve_analysis())
            workspace.authored_batch = original
            for future in session.retry_authored():
                future.result(3)
            session.wait_authored(session.cutoff())
            self.assertEqual(workspace.restore_index()['nodes']['n']['attributes']['comment'], 'must survive')

    def test_uncertain_receipt_retry_does_not_reapply_an_old_comment_over_a_newer_one(self):
        with session_storage() as (session, writer, _):
            workspace = writer.ready.result()
            original = workspace.authored_batch
            def uncertain(changes):
                original(changes)
                raise OSError('Injected missing commit receipt')
            workspace.authored_batch = uncertain
            _, old = session.accept_authored(attributes={'n': {'comment': 'old edit', 'children': []}})
            session.flush_authored()
            with self.assertRaises(OSError):
                old.result(3)
            workspace.authored_batch = original
            session.accept_authored(attributes={'n': {'comment': 'new edit', 'children': []}})
            session.flush_authored()
            for future in session.retry_authored():
                future.result(3)
            session.wait_authored(session.cutoff())
            self.assertEqual(workspace.restore_index()['nodes']['n']['attributes']['comment'], 'new edit')

    def test_session_restore_preserves_authored_state_and_lazy_analysis_without_rule_replay(self):
        with session_storage() as (session, writer, scheduler):
            session.accept_authored(attributes={'n': {'children': ['branch'], 'comment': 'edited'}}, nodes={
                'branch': {'snapshot': {'hand': ['7p'], 'history': ['accepted action']},
                           'attributes': {'children': [], 'parentId': 'n', 'comment': 'branch note'}}})
            session.move_cursor({'currentNodeId': 'branch', 'controlledSeat': 2, 'mode': 'research'})
            admission = session.reserve_analysis()
            identity = session.accept_analysis(admission, 'branch/decision/2', {'probability': .75},
                                               epoch=0, kind='decision', seat=2)
            cutoff = session.cutoff(freeze=True)
            session.wait_authored(cutoff)
            with session.results.capture() as versions:
                session.results.portable(versions[0])
                versions[0].durable.result(3)
            session.stop()
            scheduler.close()
            writer.close()
            next_writer = RecordWorkspaceWriter(writer.path, 'session')
            next_scheduler = RecordCodecScheduler()
            try:
                restored, game, state = RecordSessionStorage.restore('session', next_scheduler, next_writer)
                self.assertNotEqual(restored.session_id, session.session_id)
                self.assertEqual(restored.content_revision, cutoff.content)
                self.assertEqual(game['currentNodeId'], 'branch')
                self.assertEqual(game['nodes']['n']['comment'], 'edited')
                self.assertEqual(game['nodes']['branch']['snapshot']['history'], ['accepted action'])
                self.assertEqual(state['controlledSeat'], 2)
                self.assertIsNone(next_scheduler.client.pid)
                self.assertEqual(restored.results.slot('branch/decision/2'), identity)
                restored.results.request(identity).result(5)
                self.assertEqual(restored.results.hot(identity), {'probability': .75})
                restored.stop()
            finally:
                next_scheduler.close()
                next_writer.close()
