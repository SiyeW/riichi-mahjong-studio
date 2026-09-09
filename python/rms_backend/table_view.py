import copy


def resolve_last_drawn_tile(snapshot, seat):
    if snapshot.get("currentActor") != seat:
        return None
    if snapshot.get("phase") == "game_end":
        last_action = snapshot.get("lastAction") or {}
        if last_action.get("type") == "hora" and last_action.get("actor") == seat:
            if last_action.get("isTsumo", last_action.get("actor") == last_action.get("target")):
                return str(last_action.get("pai") or "")
        return None
    if snapshot.get("phase") not in ("discard", "draw_or_discard", "reach_declaration", "round_result"):
        return None
    for action in reversed(snapshot.get("actionHistory", [])):
        if int(action.get("actor", -1)) != seat:
            continue
        action_type = str(action.get("type") or "")
        if action_type == "tsumo":
            return str(action.get("pai") or "")
        if action_type in ("chi", "pon", "daiminkan", "ankan", "kakan", "dahai", "hora", "ryukyoku"):
            return None
    return None


def resolve_display_last_draw_state(snapshot):
    last_action = snapshot.get("lastAction") or {}
    phase = snapshot.get("phase")
    if phase == "game_end" and last_action.get("type") == "hora":
        winner = int(last_action.get("actor", -1))
        target = int(last_action.get("target", winner))
        if winner >= 0 and last_action.get("isTsumo", winner == target):
            tile = str(last_action.get("pai") or "")
            return winner, tile or None
        return None, None
    if phase == "round_result" and last_action.get("type") == "round_result":
        result = last_action.get("result") or {}
        if result.get("eventType") == "hora":
            event_data = result.get("eventData") or {}
            winner = int(event_data.get("actor", -1))
            target = int(event_data.get("target", winner))
            if winner >= 0 and winner == target:
                tile = str(event_data.get("pai") or "")
                return winner, tile or None
    current_actor = snapshot.get("currentActor")
    if current_actor is None:
        return None, None
    tile = resolve_last_drawn_tile(snapshot, current_actor)
    if tile:
        return int(current_actor), tile
    return None, None


def build_table_view(
    snapshot,
    *,
    controlled_seat,
    visible_hands,
    match_id,
    auto_advance_mode,
    result_info,
):
    last_drawn_seat, last_drawn_tile = resolve_display_last_draw_state(snapshot)
    hands_view = []
    revealed_seats = set()
    last = snapshot.get("lastAction") or {}
    if last.get("type") == "hora":
        revealed_seats.add(int(last.get("actor", -1)))
    elif last.get("type") == "ryukyoku":
        revealed_seats.update(int(seat) for seat in last.get("tenpaiSeats", []))
    elif last.get("type") == "round_result":
        result = last.get("result") or {}
        event_data = result.get("eventData") or {}
        if result.get("eventType") == "hora":
            revealed_seats.add(int(event_data.get("actor", -1)))
        elif result.get("eventType") == "ryukyoku":
            revealed_seats.update(int(seat) for seat in event_data.get("tenpaiSeats", []))
    for seat, hand in enumerate(snapshot["hands"]):
        hands_view.append(hand[:] if seat == controlled_seat or visible_hands or seat in revealed_seats else ["?"] * len(hand))

    return {
        "matchId": match_id,
        "bakaze": snapshot["bakaze"],
        "kyoku": snapshot["kyoku"],
        "honba": snapshot["honba"],
        "kyotaku": snapshot["kyotaku"],
        "roundIndex": snapshot["roundIndex"],
        "westEntered": snapshot.get("westEntered", False),
        "dealer": snapshot["dealer"],
        "currentActor": snapshot["currentActor"],
        "phase": snapshot["phase"],
        "turn": snapshot["turn"],
        "drawIndex": snapshot["drawIndex"],
        "lastDrawnSeat": last_drawn_seat,
        "lastDrawnTile": last_drawn_tile,
        "autoAdvanceMode": auto_advance_mode,
        "wallRemaining": len(snapshot["wall"]) - snapshot["drawIndex"],
        "doraIndicators": snapshot["doraIndicators"][:],
        "uraIndicators": snapshot.get("uraIndicators", [])[:],
        "scores": snapshot["scores"][:],
        "hands": hands_view,
        "rivers": copy.deepcopy(snapshot["rivers"]),
        "melds": copy.deepcopy(snapshot["melds"]),
        "actionHistory": copy.deepcopy(snapshot.get("actionHistory", [])),
        "riichiDeclared": copy.deepcopy(snapshot.get("riichiDeclared", [False] * 4)),
        "riichiAccepted": copy.deepcopy(snapshot.get("riichiAccepted", [False] * 4)),
        "ippatsuEligible": copy.deepcopy(snapshot.get("ippatsuEligible", [False] * 4)),
        "pendingRiichiSeat": snapshot.get("pendingRiichiSeat"),
        "riichiDiscardState": snapshot.get("riichiDiscardState"),
        "pendingRiichiDiscard": copy.deepcopy(snapshot.get("pendingRiichiDiscard")),
        "pendingKan": copy.deepcopy(snapshot.get("pendingKan")),
        "pendingDiscard": copy.deepcopy(snapshot["pendingDiscard"]),
        "reactionWindow": copy.deepcopy(snapshot["reactionWindow"]),
        "kanReactionWindow": copy.deepcopy(snapshot.get("kanReactionWindow")),
        "lastAction": copy.deepcopy(snapshot["lastAction"]),
        "resultInfo": result_info,
    }


def build_match_summary(game, snapshot):
    match_state = copy.deepcopy(game.get("matchState") or snapshot.get("matchState") or {})
    for field in ("bakaze", "kyoku", "honba", "kyotaku", "dealer", "roundIndex"):
        match_state[field] = snapshot[field]
    match_state["scores"] = copy.deepcopy(snapshot["scores"])
    match_state["westEntered"] = snapshot.get("westEntered", False)
    return {
        "matchId": game.get("matchId") or game.get("gameId"),
        "matchType": (game.get("matchConfig") or {}).get("matchType", "hanchan"),
        "roundIndex": match_state.get("roundIndex", 0),
        "bakaze": match_state.get("bakaze", "E"),
        "kyoku": match_state.get("kyoku", 1),
        "honba": match_state.get("honba", 0),
        "kyotaku": match_state.get("kyotaku", 0),
        "scores": copy.deepcopy(match_state.get("scores", [25000] * 4)),
        "dealer": match_state.get("dealer", 0),
        "westEntered": bool(match_state.get("westEntered", False)),
        "ended": bool(match_state.get("ended", False)),
    }
