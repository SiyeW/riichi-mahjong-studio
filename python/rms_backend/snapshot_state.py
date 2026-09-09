import copy


DEFAULT_SCORES = [25000, 25000, 25000, 25000]
EMPTY_SEAT_LISTS = [[], [], [], []]
FALSE_BY_SEAT = [False, False, False, False]


def get_pending_dora_counts(snapshot):
    immediate = int(snapshot.get("pendingDoraRevealCount", 1 if snapshot.get("pendingDoraReveal") else 0))
    delayed = int(snapshot.get("pendingDoraRevealAfterActionCount", 0))
    return immediate, delayed


def set_pending_dora_counts(snapshot, immediate, delayed):
    immediate = max(0, int(immediate))
    delayed = max(0, int(delayed))
    if immediate:
        snapshot["pendingDoraRevealCount"] = immediate
        snapshot["pendingDoraReveal"] = True
    else:
        snapshot.pop("pendingDoraRevealCount", None)
        snapshot.pop("pendingDoraReveal", None)
    if delayed:
        snapshot["pendingDoraRevealAfterActionCount"] = delayed
    else:
        snapshot.pop("pendingDoraRevealAfterActionCount", None)


def sync(snapshot):
    match_state = snapshot.get("matchState")
    kyoku_state = snapshot.get("kyokuState")

    if not isinstance(match_state, dict):
        match_state = {
            "roundIndex": int(snapshot.get("roundIndex", 0)),
            "bakaze": snapshot.get("bakaze", "E"),
            "kyoku": int(snapshot.get("kyoku", 1)),
            "honba": int(snapshot.get("honba", 0)),
            "kyotaku": int(snapshot.get("kyotaku", 0)),
            "dealer": int(snapshot.get("dealer", 0)),
            "dealerOffset": int(snapshot.get("dealerOffset", 0)),
            "scores": copy.deepcopy(snapshot.get("scores", DEFAULT_SCORES)),
            "westEntered": bool(snapshot.get("westEntered", False)),
            "ended": snapshot.get("phase") == "match_end",
            "inRenchan": bool(snapshot.get("inRenchan", False)),
        }

    if not isinstance(kyoku_state, dict):
        kyoku_state = {
            "initialHands": copy.deepcopy(snapshot.get("initialHands", EMPTY_SEAT_LISTS)),
            "startScores": copy.deepcopy(snapshot.get("startScores", snapshot.get("scores", DEFAULT_SCORES))),
            "startKyotaku": int(snapshot.get("startKyotaku", snapshot.get("kyotaku", 0))),
            "fullWall": copy.deepcopy(snapshot.get("fullWall", [])),
            "hands": copy.deepcopy(snapshot.get("hands", EMPTY_SEAT_LISTS)),
            "rivers": copy.deepcopy(snapshot.get("rivers", EMPTY_SEAT_LISTS)),
            "wall": copy.deepcopy(snapshot.get("wall", [])),
            "rinshanWall": copy.deepcopy(snapshot.get("rinshanWall", [])),
            "drawIndex": int(snapshot.get("drawIndex", 0)),
            "doraIndicators": copy.deepcopy(snapshot.get("doraIndicators", [])),
            "uraIndicators": copy.deepcopy(snapshot.get("uraIndicators", [])),
            "doraIndicatorStack": copy.deepcopy(snapshot.get("doraIndicatorStack", [])),
            "uraIndicatorStack": copy.deepcopy(snapshot.get("uraIndicatorStack", [])),
            "melds": copy.deepcopy(snapshot.get("melds", EMPTY_SEAT_LISTS)),
            "riichiDeclared": copy.deepcopy(snapshot.get("riichiDeclared", FALSE_BY_SEAT)),
            "riichiAccepted": copy.deepcopy(snapshot.get("riichiAccepted", FALSE_BY_SEAT)),
            "ippatsuEligible": copy.deepcopy(snapshot.get("ippatsuEligible", FALSE_BY_SEAT)),
            "pendingRiichiSeat": snapshot.get("pendingRiichiSeat"),
            "pendingRiichiDiscard": copy.deepcopy(snapshot.get("pendingRiichiDiscard")),
            "pendingKan": copy.deepcopy(snapshot.get("pendingKan")),
            "pendingRinshanDraw": bool(snapshot.get("pendingRinshanDraw", False)),
            "pendingDoraRevealCount": int(
                snapshot.get("pendingDoraRevealCount", 1 if snapshot.get("pendingDoraReveal") else 0)
            ),
            "pendingDoraRevealAfterActionCount": int(snapshot.get("pendingDoraRevealAfterActionCount", 0)),
        }

    snapshot["matchState"] = match_state
    snapshot["kyokuState"] = kyoku_state

    snapshot["roundIndex"] = int(match_state.get("roundIndex", 0))
    snapshot["bakaze"] = match_state.get("bakaze", "E")
    snapshot["kyoku"] = int(match_state.get("kyoku", 1))
    snapshot["honba"] = int(match_state.get("honba", 0))
    snapshot["kyotaku"] = int(match_state.get("kyotaku", 0))
    snapshot["dealer"] = int(match_state.get("dealer", 0))
    snapshot["dealerOffset"] = int(match_state.get("dealerOffset", 0))
    snapshot["scores"] = copy.deepcopy(match_state.get("scores", DEFAULT_SCORES))
    snapshot["westEntered"] = bool(match_state.get("westEntered", False))
    snapshot["inRenchan"] = bool(match_state.get("inRenchan", False))
    if "seed" not in snapshot:
        snapshot["seed"] = match_state.get("seed", 0)
    if "roundSeeds" not in snapshot:
        snapshot["roundSeeds"] = copy.deepcopy(match_state.get("roundSeeds", []))

    snapshot["initialHands"] = copy.deepcopy(kyoku_state.get("initialHands", EMPTY_SEAT_LISTS))
    snapshot["startScores"] = copy.deepcopy(
        kyoku_state.get("startScores", snapshot.get("scores", DEFAULT_SCORES))
    )
    snapshot["startKyotaku"] = int(kyoku_state.get("startKyotaku", snapshot.get("kyotaku", 0)))
    snapshot["fullWall"] = copy.deepcopy(kyoku_state.get("fullWall", []))
    snapshot["hands"] = copy.deepcopy(kyoku_state.get("hands", EMPTY_SEAT_LISTS))
    snapshot["rivers"] = copy.deepcopy(kyoku_state.get("rivers", EMPTY_SEAT_LISTS))
    snapshot["wall"] = copy.deepcopy(kyoku_state.get("wall", []))
    snapshot["rinshanWall"] = copy.deepcopy(kyoku_state.get("rinshanWall", []))
    snapshot["drawIndex"] = int(kyoku_state.get("drawIndex", 0))
    snapshot["doraIndicators"] = copy.deepcopy(kyoku_state.get("doraIndicators", []))
    snapshot["uraIndicators"] = copy.deepcopy(kyoku_state.get("uraIndicators", []))
    snapshot["doraIndicatorStack"] = copy.deepcopy(kyoku_state.get("doraIndicatorStack", []))
    snapshot["uraIndicatorStack"] = copy.deepcopy(kyoku_state.get("uraIndicatorStack", []))
    snapshot["melds"] = copy.deepcopy(kyoku_state.get("melds", EMPTY_SEAT_LISTS))
    snapshot["riichiDeclared"] = copy.deepcopy(kyoku_state.get("riichiDeclared", FALSE_BY_SEAT))
    snapshot["riichiAccepted"] = copy.deepcopy(kyoku_state.get("riichiAccepted", FALSE_BY_SEAT))
    snapshot["ippatsuEligible"] = copy.deepcopy(kyoku_state.get("ippatsuEligible", FALSE_BY_SEAT))
    snapshot["pendingRiichiSeat"] = kyoku_state.get("pendingRiichiSeat")
    snapshot["pendingRiichiDiscard"] = copy.deepcopy(kyoku_state.get("pendingRiichiDiscard"))
    snapshot["pendingKan"] = copy.deepcopy(kyoku_state.get("pendingKan"))
    snapshot["pendingRinshanDraw"] = bool(kyoku_state.get("pendingRinshanDraw", False))
    set_pending_dora_counts(
        snapshot,
        int(kyoku_state.get("pendingDoraRevealCount", 1 if kyoku_state.get("pendingDoraReveal") else 0)),
        int(kyoku_state.get("pendingDoraRevealAfterActionCount", 0)),
    )
    return snapshot


def persist(snapshot):
    if "matchState" not in snapshot or "kyokuState" not in snapshot:
        sync(snapshot)
    match_state = snapshot["matchState"]
    kyoku_state = snapshot["kyokuState"]

    match_state["roundIndex"] = int(snapshot.get("roundIndex", 0))
    match_state["bakaze"] = snapshot.get("bakaze", "E")
    match_state["kyoku"] = int(snapshot.get("kyoku", 1))
    match_state["honba"] = int(snapshot.get("honba", 0))
    match_state["kyotaku"] = int(snapshot.get("kyotaku", 0))
    match_state["dealer"] = int(snapshot.get("dealer", 0))
    if "dealerOffset" in snapshot:
        match_state["dealerOffset"] = int(snapshot["dealerOffset"])
    match_state["scores"] = copy.deepcopy(snapshot.get("scores", DEFAULT_SCORES))
    match_state["westEntered"] = bool(snapshot.get("westEntered", False))
    match_state["inRenchan"] = bool(snapshot.get("inRenchan", False))
    match_state["ended"] = snapshot.get("phase") == "match_end"

    kyoku_state["initialHands"] = copy.deepcopy(snapshot.get("initialHands", EMPTY_SEAT_LISTS))
    kyoku_state["startScores"] = copy.deepcopy(
        snapshot.get("startScores", snapshot.get("scores", DEFAULT_SCORES))
    )
    kyoku_state["startKyotaku"] = int(snapshot.get("startKyotaku", snapshot.get("kyotaku", 0)))
    kyoku_state["fullWall"] = copy.deepcopy(snapshot.get("fullWall", []))
    kyoku_state["hands"] = copy.deepcopy(snapshot.get("hands", EMPTY_SEAT_LISTS))
    kyoku_state["rivers"] = copy.deepcopy(snapshot.get("rivers", EMPTY_SEAT_LISTS))
    kyoku_state["wall"] = copy.deepcopy(snapshot.get("wall", []))
    kyoku_state["rinshanWall"] = copy.deepcopy(snapshot.get("rinshanWall", []))
    kyoku_state["drawIndex"] = int(snapshot.get("drawIndex", 0))
    kyoku_state["doraIndicators"] = copy.deepcopy(snapshot.get("doraIndicators", []))
    kyoku_state["uraIndicators"] = copy.deepcopy(snapshot.get("uraIndicators", []))
    kyoku_state["doraIndicatorStack"] = copy.deepcopy(snapshot.get("doraIndicatorStack", []))
    kyoku_state["uraIndicatorStack"] = copy.deepcopy(snapshot.get("uraIndicatorStack", []))
    kyoku_state["melds"] = copy.deepcopy(snapshot.get("melds", EMPTY_SEAT_LISTS))
    kyoku_state["riichiDeclared"] = copy.deepcopy(snapshot.get("riichiDeclared", FALSE_BY_SEAT))
    kyoku_state["riichiAccepted"] = copy.deepcopy(snapshot.get("riichiAccepted", FALSE_BY_SEAT))
    kyoku_state["ippatsuEligible"] = copy.deepcopy(snapshot.get("ippatsuEligible", FALSE_BY_SEAT))
    kyoku_state["pendingRiichiSeat"] = snapshot.get("pendingRiichiSeat")
    kyoku_state["pendingRiichiDiscard"] = copy.deepcopy(snapshot.get("pendingRiichiDiscard"))
    kyoku_state["pendingKan"] = copy.deepcopy(snapshot.get("pendingKan"))
    kyoku_state["pendingRinshanDraw"] = bool(snapshot.get("pendingRinshanDraw", False))
    immediate, delayed = get_pending_dora_counts(snapshot)
    kyoku_state["pendingDoraRevealCount"] = immediate
    kyoku_state["pendingDoraRevealAfterActionCount"] = delayed
    return snapshot
