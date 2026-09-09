import copy
import random


def get_round_seed(match_state, round_index):
    round_seeds = match_state.get("roundSeeds") or []
    if round_index < len(round_seeds):
        return round_seeds[round_index]
    randomizer = random.Random(int(match_state.get("seed") or 0))
    for _ in range(len(round_seeds)):
        randomizer.randint(100000, 999999)
    while len(round_seeds) <= round_index:
        round_seeds.append(randomizer.randint(100000, 999999))
    match_state["roundSeeds"] = round_seeds
    return round_seeds[round_index]


def round_index_to_bakaze_kyoku(round_index):
    if round_index < 4:
        return "E", round_index + 1
    if round_index < 8:
        return "S", round_index - 3
    return "W", round_index - 7


def set_match_round_fields(match_state):
    bakaze, kyoku = round_index_to_bakaze_kyoku(int(match_state.get("roundIndex", 0)))
    match_state["bakaze"] = bakaze
    match_state["kyoku"] = kyoku
    match_state["dealer"] = int(match_state.get("roundIndex", 0)) % 4
    match_state["westEntered"] = int(match_state.get("roundIndex", 0)) >= 8
    return match_state


def get_top_seat(scores):
    return max(range(len(scores)), key=lambda index: scores[index])


def get_match_length(match_state):
    match_type = str(match_state.get("matchType", "hanchan")).lower()
    if match_type == "tonpuu":
        return 4
    return 8


def get_all_last_round_index(match_state):
    return get_match_length(match_state) - 1


def get_max_west_round_index(match_state):
    return get_match_length(match_state) + 3


def has_target_score(scores):
    return any(score >= 30000 for score in scores)


def has_bust_score(scores):
    return any(score < 0 for score in scores)


def should_end_after_round(current_round_index, match_state, round_result, scores):
    if has_bust_score(scores):
        return True

    all_last_index = get_all_last_round_index(match_state)
    max_west_index = get_max_west_round_index(match_state)
    west_enabled = bool(match_state.get("westEntryEnabled", True))
    dealer = current_round_index % 4
    can_renchan = bool(round_result.get("canRenchan", False))
    has_hora = bool(round_result.get("hasHora", False))
    has_abortive_ryukyoku = bool(round_result.get("hasAbortiveRyukyoku", False))

    if current_round_index < all_last_index:
        return False

    if current_round_index == all_last_index:
        if has_abortive_ryukyoku:
            return False
        if can_renchan:
            if has_hora:
                return scores[dealer] >= 30000 and get_top_seat(scores) == dealer
            return False
        if not west_enabled:
            return True
        return has_target_score(scores)

    if has_target_score(scores):
        return True

    if current_round_index >= max_west_index:
        return not can_renchan

    return False


def apply_round_result_to_match_state(match_state, round_result):
    next_state = copy.deepcopy(match_state)
    next_state["scores"] = copy.deepcopy(round_result["scores"])
    next_state["kyotaku"] = int(round_result["kyotakuLeft"])
    next_state["ended"] = False
    next_state["inRenchan"] = False

    current_round_index = int(next_state.get("roundIndex", 0))
    end_now = should_end_after_round(current_round_index, next_state, round_result, next_state["scores"])

    if round_result["hasAbortiveRyukyoku"]:
        if end_now:
            set_match_round_fields(next_state)
            next_state["ended"] = True
            return next_state
        next_state["honba"] = int(next_state.get("honba", 0)) + 1
        set_match_round_fields(next_state)
        return next_state

    if not round_result["canRenchan"]:
        if end_now:
            set_match_round_fields(next_state)
            next_state["ended"] = True
            return next_state
        next_state["roundIndex"] = current_round_index + 1
        if round_result["hasHora"]:
            next_state["honba"] = 0
        else:
            next_state["honba"] = int(next_state.get("honba", 0)) + 1
        set_match_round_fields(next_state)
        next_state["ended"] = False
        return next_state

    if end_now:
        next_state["ended"] = True
        set_match_round_fields(next_state)
        return next_state

    next_state["inRenchan"] = True
    next_state["honba"] = int(next_state.get("honba", 0)) + 1
    set_match_round_fields(next_state)
    next_state["ended"] = False
    return next_state
