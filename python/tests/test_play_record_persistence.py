"""Actual gameplay/mutation/storage, with inference readiness and seat fixed.

This verifies recorded state and recovery, not a model's decision quality or an
engine initialization. Process-boundary recovery has its separate integration.
"""

import copy
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4

from rms_backend import service
from rms_backend.records.codec_scheduler import RecordCodecScheduler
from rms_backend.records.resources import RecordResourceManager
from rms_backend.records.session import RecordSession
from rms_backend.records.session_storage import RecordSessionStorage
from rms_backend.records.workspace_writer import RecordWorkspaceWriter
from rms_backend.records.file import read_record_file


class PlayRecordPersistenceTests(unittest.TestCase):
    def test_real_discard_and_name_edits_restore_without_rules_randomness_or_ai_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            lane = RecordCodecScheduler()
            manager = RecordResourceManager(Path(directory) / 'workspaces', lambda: lane)
            deps = replace(service.RECORD_SESSION.dependencies, prewarm_action_engine=lambda *_: None,
                           storage_changed=manager.activate)
            session = RecordSession(service.STATE, deps, storage_factory=manager.create)
            identity = str(uuid4())
            state = dict(game=None, gameLoaded=False, mode='play', controlledSeat=0,
                         pendingSeatSwitch=None, visibleHands=False, nextGameId=1,
                         decisionRecommendationsEnabled=False, opponentAnalysisEnabled=False)
            try:
                with patch.dict(service.STATE, state), patch.object(service, 'RECORD_SESSION', session), \
                     patch('rms_backend.records.session.random.randint', side_effect=(123456, 0)), \
                     patch.object(service.GAMEPLAY_COMMANDS, '_ensure_play_mode', service.ensure_game_loaded), \
                     patch.object(service.ACTION_RECOMMENDATIONS, 'accepts_requests', return_value=False):
                    with manager.candidate(identity):
                        session.create()
                    manager.confirm_activation(identity)
                    service.STATE['controlledSeat'] = 0
                    view = service.VIEW_BUILDER.build_view_payload()
                    discard = next(action for action in view['legalActions'] if action['type'] == 'dahai')
                    captured = session.prepare_export()
                    captured_nodes = set(service.STATE['game']['nodes'])
                    captured_hands = copy.deepcopy(service.STATE['game']['nodes'][view['currentNodeId']]['snapshot']['hands'])
                    played = service.STATEFUL_COMMANDS.dispatch(1, 'submit_user_action', dict(
                        type='dahai', pai=discard['pai'], fromDrawn=bool(discard.get('tsumogiri'))))
                    service.STATEFUL_COMMANDS.dispatch(2, 'set_player_name', dict(seat=0, name='Human — 测试'))
                    snapshot_path = Path(directory) / 'captured-before-play.mjstudio'
                    captured.write(snapshot_path)
                    saved = read_record_file(snapshot_path)
                    try:
                        self.assertEqual(set(saved['game']['nodes']), captured_nodes)
                        self.assertEqual(saved['game']['nodes'][view['currentNodeId']]['snapshot']['hands'], captured_hands)
                        self.assertNotEqual(saved['game']['metadata'].get('playerNames', [''] * 4)[0], 'Human — 测试')
                    finally:
                        saved.origin.source._close()
                    expected = copy.deepcopy(service.STATE['game'])
                    cutoff = session.storage.cutoff(freeze=True)
                    session.storage.wait_authored(cutoff)
                    database = session.storage.writer.path
                    manager.retire(identity, 'retained')
                    manager.wait_released(identity)
                    writer = RecordWorkspaceWriter(database, identity)
                    try:
                        writer.ready.result(3)
                        storage, game, restored_state = RecordSessionStorage.restore(identity, lane, writer)
                        def no_replay(*_args, **_kwargs):
                            raise AssertionError('Recovery reran rules, randomness or inference.')
                        restore_deps = replace(deps, reset_runtime=lambda: None,
                            create_empty_game=no_replay, advance_new_game=no_replay,
                            prewarm_action_engine=no_replay, storage_changed=lambda *_: None,
                            backfill_child_comparisons=lambda *_: None, request_opponent_analysis=no_replay)
                        restored = dict(state)
                        target = RecordSession(restored, restore_deps)
                        target.activate_load(target.prepare_restored(storage, game, restored_state))
                        self.assertEqual(game['currentNodeId'], played['view']['currentNodeId'])
                        self.assertEqual(game['metadata']['playerNames'][0], 'Human — 测试')
                        self.assertEqual(restored['controlledSeat'], 0)
                        def authored_nodes(value):
                            nodes = {key: {field: item for field, item in node.items()
                                     if field not in ('analysisCache', 'opponentAnalysisCache')}
                                     for key, node in value['nodes'].items()}
                            return json.loads(json.dumps(nodes))
                        self.assertEqual(authored_nodes(game), authored_nodes(expected))
                        storage.results.dispose()
                    finally:
                        writer.close()
            finally:
                service.PLAY_PREFETCH.cancel()
                manager.shutdown()
                lane.close()
                service.VIEW_CONTEXT.current()
