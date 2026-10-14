from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

from rms_backend.game_tree_coordinator import GameTreeCoordinator, GameTreeDependencies
from rms_backend.record_commands import RecordCommands
from rms_backend.record_mutation_capture import RecordMutationCapture
from rms_backend.record_session_storage import RecordSessionStorage, result_slot
from rms_backend.record_codec_scheduler import RecordCodecScheduler
from rms_backend.record_workspace_writer import RecordWorkspaceWriter
from rms_backend.record_analysis_refs import AnalysisReference


@contextmanager
def environment():
    with tempfile.TemporaryDirectory() as directory:
        writer = RecordWorkspaceWriter(Path(directory) / 'edits.sqlite', 'edits', create=True)
        lane = RecordCodecScheduler()
        storage = RecordSessionStorage('edits', lane, writer)
        game = dict(gameId='g', currentNodeId='n_0', rootNodeId='n_0', mainLeafNodeId='n_0',
                    nextNodeIndex=1, treeRevision=0, nodes={
                        'n_0': dict(id='n_0', parentId=None, children=[], mainChildId=None,
                                    snapshot={'matchState': {}}, analysisCache={}, depth=0)})
        state = dict(game=game, gameLoaded=True, mode='research', controlledSeat=0,
                     pendingSeatSwitch=None, visibleHands=False)
        journal = RecordMutationCapture(state, lambda: storage)
        tree = GameTreeCoordinator(state, GameTreeDependencies(
            sync_snapshot=lambda _: None, is_meaningful_decision=lambda *_: True,
            active_draft=lambda: None, invalidate_analysis_timeline=lambda: None,
            changed_nodes=journal.changed_nodes))
        commands = RecordCommands(state, SimpleNamespace(
            ensure_loaded=lambda: None, ensure_writable=lambda: None,
            collect_subtree_ids=lambda game, node_id: [node_id],
            cancel_play_prefetch=lambda: None, cancel_auto_analysis=lambda _: None,
            purge_background_analysis=lambda *_: None, purge_mjai_cache=lambda _: None,
            deleted_nodes=journal.deleted_nodes, changed_nodes=journal.changed_nodes,
            sync_snapshot=lambda _: None, invalidate_auto_timeline=lambda: None,
            request_opponent_analysis=lambda *_: None))
        try:
            writer.ready.result(3)
            storage.initialize(game, {key: value for key, value in state.items()
                                      if key not in ('game', 'gameLoaded')}).result(3)
            yield game, state, storage, writer, journal, tree, commands
        finally:
            storage.stop()
            storage.wait_authored(storage.cutoff())
            lane.close()
            storage.results.close()
            writer.close()


class RecordMutationCaptureTests(unittest.TestCase):
    def test_comment_never_copies_a_snapshot_and_noop_does_not_dirty_content_or_cursor(self):
        with environment() as (game, state, storage, writer, journal, tree, commands):
            class NoCopy(dict):
                def __deepcopy__(self, memo):
                    raise AssertionError('A comment copied a snapshot')
            game['nodes']['n_0']['snapshot'] = NoCopy(game['nodes']['n_0']['snapshot'])
            cursor = storage.cursor_sequence
            with journal.command('set_node_comment', {'nodeId': 'n_0'}):
                commands.set_comment('n_0', 'authored comment')
            storage.wait_authored(storage.cutoff())
            index = writer.ready.result().restore_index()
            self.assertEqual(index['nodes']['n_0']['attributes']['comment'], 'authored comment')
            self.assertEqual(index['nodes']['n_0']['snapshot'], {'matchState': {}})
            revision = storage.content_revision
            with journal.command('set_node_comment', {'nodeId': 'n_0'}):
                commands.set_comment('n_0', 'authored comment')
            self.assertEqual(storage.content_revision, revision)
            self.assertEqual(storage.cursor_sequence, cursor)

    def test_tree_creation_deletion_and_analysis_tombstone_are_one_authored_mutation(self):
        with environment() as (game, state, storage, writer, journal, tree, commands):
            with journal.command('submit_user_action', {}):
                child = tree.create_node(game, 'n_0', {'type': 'dahai', 'actor': 0, 'pai': '1m'}, {'matchState': {}})
                tree.attach_mainline('n_0', child)
                game['currentNodeId'] = child
            storage.wait_authored(storage.cutoff())
            index = writer.ready.result().restore_index()
            self.assertEqual(set(index['nodes']), {'n_0', child})
            self.assertEqual(index['nodes']['n_0']['attributes']['children'], [child])
            self.assertEqual(index['metadata']['cursor']['state']['currentNodeId'], child)
            slot = result_slot(child, 'analysisCache', 'key')
            identity = storage.accept_analysis(storage.reserve_analysis(), slot, {'seat': 0, 'extension': [0, 1]},
                                               epoch=0, kind='decision', seat=0)
            reference = AnalysisReference(storage.results, identity)
            game['nodes'][child]['analysisCache']['key'] = reference
            with storage.results.capture() as captured:
                storage.results.portable(captured[0])
                captured[0].durable.result(3)
                previous = storage.content_revision
                with journal.command('delete_node', {'nodeId': child}):
                    self.assertEqual(commands.delete(child), 1)
                storage.wait_authored(storage.cutoff())
                self.assertEqual(storage.content_revision, previous + 1)
                index = writer.ready.result().restore_index()
                self.assertEqual(set(index['nodes']), {'n_0'})
                self.assertEqual(index['nodes']['n_0']['attributes']['children'], [])
                self.assertEqual(index['slots'][0][3:], (None, None))
                self.assertEqual(index['metadata']['cursor']['state']['currentNodeId'], 'n_0')
                self.assertGreater(storage.results.portable(captured[0]).length, 0)
            storage.results.collect_garbage().result(3)

    def test_rejected_noop_gameplay_does_not_create_a_revision(self):
        with environment() as (game, state, storage, writer, journal, tree, commands):
            revision, cursor = storage.content_revision, storage.cursor_sequence
            with self.assertRaises(ValueError), journal.command('submit_user_action', {}):
                raise ValueError('invalid action')
            self.assertEqual(storage.content_revision, revision)
            self.assertEqual(storage.cursor_sequence, cursor)
