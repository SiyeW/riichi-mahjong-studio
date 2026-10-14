from dataclasses import replace
from pathlib import Path
import os
import tempfile
import unittest
from uuid import uuid4

from rms_backend import service
from rms_backend.record_archive import read_archive
from rms_backend.record_codec_scheduler import RecordCodecScheduler
from rms_backend.record_resource_manager import RecordResourceManager
from rms_backend.record_save_operations import RecordSaveOperations
from rms_backend.record_session import RecordSession


class RecordSaveFixture:
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.lane = RecordCodecScheduler()
        self.addCleanup(self.lane.close)
        self.resources = RecordResourceManager(self.root / 'workspaces', lambda: self.lane)
        self.addCleanup(self.resources.shutdown)
        self.state = dict(game=None, gameLoaded=False, mode='play', controlledSeat=0,
                          pendingSeatSwitch=None, visibleHands=False, nextGameId=1)
        dependencies = replace(service.RECORD_SESSION.dependencies,
            reset_runtime=lambda: None, advance_new_game=lambda *args: None,
            prewarm_action_engine=lambda seat: None, backfill_child_comparisons=lambda game: None,
            request_opponent_analysis=lambda *args: None, storage_changed=self.resources.activate)
        self.session = RecordSession(self.state, dependencies, storage_factory=self.resources.create)
        self.operations = RecordSaveOperations(self.resources, self.session)
        self.addCleanup(self.operations.shutdown)
        self.identity = str(uuid4())
        with self.resources.candidate(self.identity):
            self.session.create()
        self.resources.confirm_activation(self.identity)
        self.resources.set_baseline(self.identity, clean=False)

    def capture_and_write(self, name, intent):
        target = self.root / name
        save_id = str(uuid4())
        token = self.operations.capture(self.identity, save_id, str(target), intent)
        stage = Path(str(target) + '.' + save_id + '.tmp')
        result = self.operations.write(save_id, str(stage))
        self.assertEqual(result['contentRevision'], token['contentRevision'])
        return token, target, stage


class RecordSaveOperationsTests(RecordSaveFixture, unittest.TestCase):

    def test_staging_is_not_commit_and_duplicate_ack_cannot_reapply_an_old_table(self):
        token, target, stage = self.capture_and_write('record.mjstudio', 1)
        self.assertFalse(target.exists())
        self.assertEqual(self.resources.runtime()['savedContentRevision'], 0)
        self.session.storage.move_cursor(dict(currentNodeId=self.state['game']['currentNodeId'],
                                               mode='research', controlledSeat=1, visibleHands=True))
        before = self.session.storage.cursor_sequence
        os.replace(stage, target)
        first = self.operations.committed(token)
        archive = read_archive(target.open('rb'))
        self.addCleanup(archive.source._close)
        self.assertEqual(self.session.storage.writer.ready.result().metadata()['saved']['fileIdentity'],
                         archive.source.identity)
        self.assertEqual(self.operations.committed(token), first)
        self.assertEqual(self.session.storage.cursor_sequence, before)
        self.assertEqual(self.resources.runtime()['savedCursorSequence'], token['cursorSequence'])
        self.assertEqual(self.operations.abort(token['saveId'])['committed'], True)

    def test_path_intent_not_completion_or_encoding_order_selects_the_saved_baseline(self):
        newer, new_target, new_stage = self.capture_and_write('chosen-later.mjstudio', 2)
        older, old_target, old_stage = self.capture_and_write('chosen-earlier.mjstudio', 1)
        os.replace(new_stage, new_target)
        self.operations.committed(newer)
        os.replace(old_stage, old_target)
        self.operations.committed(older)
        self.assertEqual(self.resources.runtime()['savedPath'], str(new_target))
        self.assertEqual(self.session.storage.writer.ready.result().metadata()['saved']['target'], str(new_target))
        self.assertTrue(old_target.exists() and new_target.exists())

    def test_retired_record_resources_survive_staging_until_host_ack_and_lost_reply_can_use_durable_receipt(self):
        token, target, stage = self.capture_and_write('old-record.mjstudio', 1)
        old = self.session.storage
        replacement = str(uuid4())
        with self.resources.candidate(replacement):
            self.session.create()
        self.resources.confirm_activation(replacement, previous=self.identity)
        self.assertFalse(old.writer.closed.done())
        os.replace(stage, target)
        self.operations.committed(token)
        self.resources.wait_released(self.identity)
        self.assertTrue(old.writer.closed.done())
        self.assertEqual(self.resources.runtime()['workspaceId'], replacement)
        self.assertEqual(self.resources.runtime()['savedContentRevision'], 0)

        # A new operation owner has no RAM receipt, but a live workspace's
        # durable intent can acknowledge a lost host reply after restart.
        self.identity = replacement
        fresh, fresh_target, fresh_stage = self.capture_and_write('fresh.mjstudio', 2)
        os.replace(fresh_stage, fresh_target)
        self.operations.committed(fresh)
        replay = RecordSaveOperations(self.resources, self.session)
        self.assertTrue(replay.committed(fresh)['committed'])
