"""Per-visit display authority, independent of reusable analysis/body identity."""

from uuid import uuid4


class RecordViewContext:
    """Called under the game-state lock; holds only the active game's identity.

    Returning to A after visiting B is a new visit, even with identical inputs.
    Reopening a file with the same gameId is a new session. Neither identifier
    belongs in an engine request hash or in a saved analysis body.
    """

    def __init__(self, state, epochs):
        self.state, self.epochs = state, epochs
        self._game = self._key = self._token = None
        self._session = None
        self._sequence = self._intent = 0

    def begin_visit(self, intent):
        if not isinstance(intent, int) or isinstance(intent, bool) or intent < 0:
            raise ValueError('Navigation intent must be a nonnegative integer.')
        self.current()
        self._intent = intent
        self._key = None

    def current(self):
        game = self.state.get('game') if self.state.get('gameLoaded') else None
        if game is not self._game:
            self._game = game
            self._session = uuid4().hex if game is not None else None
            self._sequence = self._intent = 0
            self._key = self._token = None
        if game is None:
            return None
        decision_epoch, opponent_epoch = self.epochs()
        key = (game.get('currentNodeId'), self.state['controlledSeat'], self.state['mode'],
               bool(self.state['visibleHands']), decision_epoch, opponent_epoch, self._intent)
        if self._key != key:
            self._sequence += 1
            self._key = key
            self._token = dict(sessionId=self._session, sequence=self._sequence,
                               intent=self._intent, gameId=game.get('gameId'), nodeId=key[0],
                               seat=key[1], mode=key[2], visibleHands=key[3],
                               decisionEpoch=decision_epoch, opponentEpoch=opponent_epoch)
        return dict(self._token)

    def tag_event(self, event):
        if 'viewToken' in event:
            return event  # A captured read may not be retagged to a later visit.
        if event.get('type') not in ('analysis_ready', 'opponent_analysis_ready'):
            return event
        token = self.current()
        analysis = event.get('analysis') or {}
        seat = event.get('seat', analysis.get('seat'))
        if (token is not None and event.get('gameId') == token['gameId']
                and event.get('nodeId') == token['nodeId'] and seat in (None, token['seat'])):
            return {**event, 'viewToken': token}
        return event
