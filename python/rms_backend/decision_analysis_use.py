"""A short actual-command lease, not a renderer-owned or visited-history pin."""


class DecisionAnalysisUse:
    def __init__(self, reference, game, node, seat, cache_key, epoch):
        self.reference, self.game, self.node = reference, game, node
        self.seat, self.cache_key, self.epoch = seat, cache_key, epoch
        self._pins = reference.store.capture([reference.identity])
        self.version = self._pins.__enter__()[0]
        self.value = None
        self._closed = False

    def load(self):
        self.value = self.reference.store.load_for_use(self.version)

    def matches(self, state, epoch):
        cache = self.node.get('analysisCache') or {}
        current = cache.get(self.cache_key)
        return (state.get('game') is self.game and self.game.get('currentNodeId') == self.node.get('id')
                and self.game.get('nodes', {}).get(self.node.get('id')) is self.node
                and state.get('controlledSeat') == self.seat and epoch == self.epoch
                and getattr(current, 'identity', None) == self.reference.identity)

    def close(self):
        if not self._closed:
            self._closed = True
            self.value = None
            self._pins.__exit__(None, None, None)
