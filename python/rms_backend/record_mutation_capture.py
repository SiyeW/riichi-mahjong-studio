"""Capture actual authored command changes, not a periodic whole-record export.

Tree domain owners report affected nodes; ordinary comment/name edits never
scan or copy snapshots. Bulk wall reconstruction is explicitly a bulk mutation.
"""

import copy
from contextlib import contextmanager

from .record_session_storage import node_attributes, result_slot

_CURSOR = {'jump_to_node', 'set_mode', 'toggle_visible_hands', 'set_analysis_visibility',
           'request_seat_switch'}
_AUTHORED = {'set_node_comment', 'set_player_name', 'set_main_branch', 'delete_node',
             'submit_user_action', 'advance_game', 'confirm_pending_review',
             'request_seat_switch', 'set_analysis_visibility', 'clear_analysis_caches',
             'reconstruct_walls', 'import_wall'}


class RecordMutationCapture:
    def __init__(self, state, storage):
        self.state, self.storage = state, storage
        self._active = None

    def changed_nodes(self, game, identities, *, snapshots=False):
        active = self._active
        if active is not None and active['game'] is game:
            active['snapshots' if snapshots else 'attributes'].update(identities)

    def deleted_nodes(self, game, identities):
        active = self._active
        if active is not None and active['game'] is game:
            active['deleted'].update(identities)
            for node_id in identities:
                for field in ('analysisCache', 'opponentAnalysisCache'):
                    for key in game['nodes'][node_id].get(field, {}):
                        active['cleared'].add(result_slot(node_id, field, key))

    @staticmethod
    def _metadata(game):
        return copy.deepcopy({f'game:{key}': value for key, value in game.items()
                              if key not in ('nodes', 'currentNodeId', 'pendingReview')})

    @contextmanager
    def command(self, command, payload):
        storage, game = self.storage(), self.state.get('game')
        if storage is None or game is None or command not in _CURSOR | _AUTHORED:
            yield
            return
        if command in _AUTHORED:
            storage.check_authored_admission()  # Reject capacity BEFORE mutating user facts.
        active = dict(game=game, snapshots=set(), attributes=set(), deleted=set(), cleared=set())
        previous_node_id = game['currentNodeId']
        previous_node = game['nodes'][previous_node_id]
        previous_snapshot = copy.deepcopy(previous_node['snapshot']) if command in _AUTHORED and command not in (
            'set_node_comment', 'set_player_name') else None
        previous_attributes = node_attributes(previous_node) if previous_snapshot is not None else None
        simple = command in ('set_node_comment', 'set_player_name')
        metadata = self._metadata(game) if command in _AUTHORED else None
        if command == 'set_node_comment':
            node_id = str(payload.get('nodeId') or '')
            before = node_attributes(game['nodes'][node_id]) if node_id in game['nodes'] else None
        else:
            before = None
        if command in ('clear_analysis_caches', 'reconstruct_walls'):
            active['cleared'].update(slot for slot, _ in storage.results.live_slots())
        if not simple and command in _AUTHORED:
            active['snapshots'].add(game['currentNodeId'])
            review = game.get('pendingReview') or {}
            active['attributes'].update(value for key, value in review.items()
                                        if key.endswith('NodeId') and isinstance(value, str))
        self._active = active
        try:
            yield
        finally:
            self._active = None
            if self.storage() is storage and self.state.get('game') is game:
                if command == 'set_node_comment' and before is not None:
                    if node_attributes(game['nodes'][node_id]) != before:
                        active['attributes'].add(node_id)
                if command in ('reconstruct_walls', 'clear_analysis_caches'):
                    active['snapshots' if command == 'reconstruct_walls' else 'attributes'].update(game['nodes'])
                if not simple and command in _AUTHORED:
                    active['snapshots'].add(game['currentNodeId'])
                if (previous_snapshot is not None and previous_node_id in game['nodes']
                        and game['nodes'][previous_node_id]['snapshot'] == previous_snapshot
                        and node_attributes(game['nodes'][previous_node_id]) == previous_attributes):
                    active['snapshots'].discard(previous_node_id)
                current_metadata = {} if metadata is None else self._metadata(game)
                changed_metadata = {key: value for key, value in current_metadata.items()
                                    if key not in metadata or value != metadata[key]}
                packet = dict(
                    nodes={key: dict(snapshot=copy.deepcopy(game['nodes'][key]['snapshot']),
                                     attributes=node_attributes(game['nodes'][key]))
                           for key in active['snapshots'] if key in game['nodes']},
                    attributes={key: node_attributes(game['nodes'][key]) for key in active['attributes']
                                if key in game['nodes'] and key not in active['snapshots']},
                    deleted=sorted(active['deleted']), metadata=changed_metadata,
                    deleted_metadata=sorted(set(metadata or {}) - current_metadata.keys()))
                if active['cleared']:
                    packet['cleared_slots'] = storage.results.forget_slots(active['cleared'])
                if any(packet.values()):
                    storage.accept_authored(**packet)
                bookmark = {key: copy.deepcopy(self.state[key]) for key in (
                    'mode', 'controlledSeat', 'pendingSeatSwitch', 'visibleHands')}
                bookmark.update(currentNodeId=game['currentNodeId'], pendingReview=copy.deepcopy(game.get('pendingReview')))
                storage.move_cursor(bookmark)
