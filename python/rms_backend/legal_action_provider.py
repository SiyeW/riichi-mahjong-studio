import copy


class LegalActionProvider:
    """Build legal actions and own the research-view cache for them."""

    def __init__(
        self,
        *,
        build_actions,
        controlled_seat,
        research_mode,
        normalize_seat,
        cache_limit=4096,
    ):
        self._build_actions = build_actions
        self._controlled_seat = controlled_seat
        self._research_mode = research_mode
        self._normalize_seat = normalize_seat
        self._cache_limit = int(cache_limit)
        self._cache = {}

    def for_node(self, game, node_id, controlled_seat=None):
        snapshot = game["nodes"][node_id]["snapshot"]
        seat = self._resolve_seat(controlled_seat)
        if not self._research_mode():
            return self._build_actions(snapshot, controlled_seat=seat)

        cache_key = (
            id(game),
            node_id,
            seat,
            self._snapshot_signature(snapshot, seat),
        )
        cached = self._cache.get(cache_key)
        if cached is not None:
            return copy.deepcopy(cached)

        actions = self._build_actions(snapshot, controlled_seat=seat)
        if len(self._cache) >= self._cache_limit:
            self._cache.pop(next(iter(self._cache)))
        self._cache[cache_key] = copy.deepcopy(actions)
        return actions

    def clear_cache(self):
        self._cache.clear()

    def _resolve_seat(self, controlled_seat):
        if controlled_seat is None:
            controlled_seat = self._controlled_seat()
        return self._normalize_seat(controlled_seat)

    @staticmethod
    def _snapshot_signature(snapshot, controlled_seat):
        hands = snapshot.get("hands") or [[], [], [], []]
        action_history = snapshot.get("actionHistory") or []
        last_action = action_history[-1] if action_history else {}
        if not isinstance(last_action, dict):
            last_action = {}
        return (
            snapshot.get("phase"),
            snapshot.get("currentActor"),
            tuple(hands[controlled_seat]),
            tuple(snapshot.get("scores") or []),
            tuple(snapshot.get("riichiAccepted") or []),
            snapshot.get("riichiDiscardState"),
            snapshot.get("pendingRiichiSeat"),
            len(action_history),
            last_action.get("type"),
            last_action.get("actor"),
            last_action.get("pai"),
            tuple(len(river) for river in (snapshot.get("rivers") or [])),
            tuple(len(melds) for melds in (snapshot.get("melds") or [])),
            id(snapshot.get("reactionWindow")),
            id(snapshot.get("kanReactionWindow")),
        )
