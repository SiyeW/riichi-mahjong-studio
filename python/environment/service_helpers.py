import random
from datetime import UTC, datetime


SUIT_TILES = [
    "1m",
    "2m",
    "3m",
    "4m",
    "6m",
    "7m",
    "8m",
    "9m",
    "1p",
    "2p",
    "3p",
    "4p",
    "6p",
    "7p",
    "8p",
    "9p",
    "1s",
    "2s",
    "3s",
    "4s",
    "6s",
    "7s",
    "8s",
    "9s",
]
HONOR_TILES = ["E", "S", "W", "N", "P", "F", "C"]
SEAT_LABELS = ["East", "South", "West", "North"]
RINSHAN_DRAW_POSITIONS = (135, 134, 133, 132)
DORA_INDICATOR_POSITIONS = (131, 129, 127, 125, 123)
URA_INDICATOR_POSITIONS = (130, 128, 126, 124, 122)


def _global_best_entry(analysis):
    """Return the engine-selected concrete candidate, falling back to raw value."""
    discard_entries = analysis.get("discardEntries") or []
    special_entries = analysis.get("specialEntries") or []
    reaction_entries = analysis.get("reactionEntries") or []
    all_entries = discard_entries + special_entries + reaction_entries
    if not all_entries:
        return None
    selected = next((entry for entry in all_entries if entry.get("isBest")), None)
    if selected is not None:
        return selected
    return max(all_entries, key=lambda entry: float(entry.get("value", 0.0)))


def normalize_tile_family(tile):
    return str(tile).replace("5mr", "5m").replace("5pr", "5p").replace("5sr", "5s").replace("r", "")


def _find_discard_entry(discard_entries, chosen_tile, from_drawn=None):
    exact_entries = [
        entry for entry in discard_entries
        if entry.get("pai") == chosen_tile
    ]
    if from_drawn is not None:
        physical_match = next(
            (
                entry for entry in exact_entries
                if bool(entry.get("tsumogiri")) == bool(from_drawn)
            ),
            None,
        )
        if physical_match is not None:
            return physical_match
    if len(exact_entries) == 1:
        return exact_entries[0]

    normalized = normalize_tile_family(chosen_tile)
    matching_family_entries = [
        entry for entry in discard_entries
        if normalize_tile_family(entry.get("pai")) == normalized
    ]
    if len(matching_family_entries) == 1:
        return matching_family_entries[0]
    return None


def build_comparison_result(analysis, chosen_tile, actor, from_drawn=None):
    discard_entries = analysis.get("discardEntries") or []
    chosen_entry = _find_discard_entry(discard_entries, chosen_tile, from_drawn)
    best_discard = discard_entries[0] if discard_entries else None
    global_best = _global_best_entry(analysis)

    if not chosen_entry or not best_discard:
        return None

    best_prob = float(global_best.get("probability", 0.0)) if global_best else float(best_discard.get("probability", 0.0))
    global_best_key = (global_best.get("variant") or global_best.get("pai") or global_best.get("type")) if global_best else best_discard.get("pai")
    global_best_label = global_best.get("label") or str(global_best_key) if global_best else str(best_discard.get("pai"))

    return {
        "actor": actor,
        "phase": "discard",
        "chosenKey": chosen_tile,
        "bestKey": str(global_best_key),
        "chosenLabel": chosen_tile,
        "bestLabel": str(global_best_label),
        "chosenPai": chosen_tile,
        "bestPai": global_best.get("pai") if global_best else best_discard.get("pai"),
        "isBest": bool(chosen_entry.get("isBest")),
        "chosenValue": chosen_entry.get("value"),
        "bestValue": global_best.get("value") if global_best else best_discard.get("value"),
        "chosenProbability": chosen_entry.get("probability"),
        "bestProbability": best_prob,
        "chosenBar": chosen_entry.get("bar"),
        "bestBar": global_best.get("bar") if global_best else best_discard.get("bar"),
        "valueGap": float((global_best or best_discard).get("value", 0.0)) - float(chosen_entry.get("value", 0.0)),
        "probabilityGap": best_prob - float(chosen_entry.get("probability", 0.0)),
        "chosenRank": chosen_entry.get("rank"),
    }


def build_reaction_comparison_result(
    analysis,
    action_type,
    actor,
    variant=None,
    candidate_id=None,
    consumed=None,
):
    reaction_entries = analysis.get("reactionEntries") or []
    canonical_consumed = tuple(sorted(str(tile) for tile in (consumed or [])))
    chosen_entry = next(
        (
            entry for entry in reaction_entries
            if (
                (candidate_id is not None and entry.get("candidateId") == candidate_id)
                or (
                    candidate_id is None
                    and entry.get("type") == action_type
                    and (variant is None or entry.get("variant") == variant)
                    and (
                        consumed is None
                        or tuple(sorted(str(tile) for tile in (entry.get("consumed") or [])))
                        == canonical_consumed
                    )
                )
            )
        ),
        None,
    )
    best_reaction = next((entry for entry in reaction_entries if entry.get("isBest")), None)
    if best_reaction is None and reaction_entries:
        best_reaction = min(reaction_entries, key=lambda entry: int(entry.get("rank") or 999))
    global_best = _global_best_entry(analysis)

    if not chosen_entry or not best_reaction:
        return None

    chosen_key = chosen_entry.get("candidateId") or chosen_entry.get("variant") or chosen_entry.get("type")
    best_prob = float(global_best.get("probability", 0.0)) if global_best else float(best_reaction.get("probability", 0.0))
    best_value = global_best.get("value") if global_best else best_reaction.get("value")
    global_best_key = (global_best.get("variant") or global_best.get("pai") or global_best.get("type")) if global_best else (best_reaction.get("variant") or best_reaction.get("type"))
    global_best_label = global_best.get("label") or str(global_best_key) if global_best else best_reaction.get("label") or str(global_best_key)
    chosen_label = chosen_entry.get("label") or chosen_key

    return {
        "actor": actor,
        "phase": "reaction",
        "chosenKey": chosen_key,
        "bestKey": str(global_best_key),
        "chosenLabel": chosen_label,
        "bestLabel": str(global_best_label),
        "chosenPai": chosen_entry.get("pai"),
        "bestPai": global_best.get("pai") if global_best else best_reaction.get("pai"),
        "isBest": bool(chosen_entry.get("isBest")),
        "chosenValue": chosen_entry.get("value"),
        "bestValue": best_value,
        "chosenProbability": chosen_entry.get("probability"),
        "bestProbability": best_prob,
        "chosenBar": chosen_entry.get("bar"),
        "bestBar": global_best.get("bar") if global_best else best_reaction.get("bar"),
        "valueGap": float(best_value or 0.0) - float(chosen_entry.get("value", 0.0)),
        "probabilityGap": best_prob - float(chosen_entry.get("probability", 0.0)),
        "chosenRank": chosen_entry.get("rank"),
    }


def build_special_action_comparison_result(analysis, action_type, actor, variant=None):
    special_entries = analysis.get("specialEntries") or []
    chosen_entry = next(
        (
            entry for entry in special_entries
            if entry.get("type") == action_type and (variant is None or entry.get("variant") == variant)
        ),
        None,
    )
    best_special = None
    if special_entries:
        best_special = max(
            special_entries,
            key=lambda entry: float(entry.get("value", 0.0)),
        )
    global_best = _global_best_entry(analysis)

    if not chosen_entry or not best_special:
        return None

    chosen_key = chosen_entry.get("variant") or chosen_entry.get("type")
    best_prob = float(global_best.get("probability", 0.0)) if global_best else float(best_special.get("probability", 0.0))
    best_value = global_best.get("value") if global_best else best_special.get("value")
    global_best_key = (global_best.get("variant") or global_best.get("pai") or global_best.get("type")) if global_best else (best_special.get("variant") or best_special.get("type"))
    global_best_label = global_best.get("label") or str(global_best_key) if global_best else best_special.get("label") or str(global_best_key)

    return {
        "actor": actor,
        "phase": "special",
        "chosenKey": chosen_key,
        "bestKey": str(global_best_key),
        "chosenLabel": chosen_entry.get("label") or chosen_key,
        "bestLabel": str(global_best_label),
        "chosenPai": chosen_entry.get("pai"),
        "bestPai": global_best.get("pai") if global_best else best_special.get("pai"),
        "isBest": chosen_entry is global_best,
        "chosenValue": chosen_entry.get("value"),
        "bestValue": best_value,
        "chosenProbability": chosen_entry.get("probability"),
        "bestProbability": best_prob,
        "chosenBar": chosen_entry.get("bar"),
        "bestBar": global_best.get("bar") if global_best else best_special.get("bar"),
        "valueGap": float(best_value or 0.0) - float(chosen_entry.get("value", 0.0)),
        "probabilityGap": best_prob - float(chosen_entry.get("probability", 0.0)),
        "chosenRank": chosen_entry.get("rank"),
    }


def now_iso():
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def build_wall(randomizer):
    """Build a shuffled wall in the application's physical index order.

    Indices 0-51 are the four starting hands, 52-121 are live-wall draws,
    and 122-135 are the dead wall.  Callers interpret the dead-wall slots via
    the application's dora, ura-dora, and rinshan position constants.
    """
    sequence = []
    for suit in ("m", "p", "s"):
        for number in range(1, 10):
            tile = f"{number}{suit}"
            if number == 5:
                sequence.extend((f"5{suit}r", tile, tile, tile))
            else:
                sequence.extend((tile, tile, tile, tile))
    for tile in HONOR_TILES:
        sequence.extend((tile, tile, tile, tile))
    randomizer.shuffle(sequence)
    return sequence


def sort_tiles(tiles):
    def tile_key(tile):
        suit_order = {"m": 0, "p": 1, "s": 2}
        honor_order = {"E": 30, "S": 31, "W": 32, "N": 33, "P": 34, "F": 35, "C": 36}
        if tile in honor_order:
            return (3, honor_order[tile], tile)
        base = tile.replace("r", "")
        number = int(base[0])
        suit = base[1]
        red_bonus = 0.5 if tile.endswith("r") else 0
        return (suit_order.get(suit, 9), number + red_bonus, tile)

    return sorted(tiles, key=tile_key)


def unique_preserving_order(items):
    seen = set()
    result = []
    for item in items:
        if item in seen:
            continue
        seen.add(item)
        result.append(item)
    return result


def get_abortive_reason_label(reason):
    return {
        "kyuushu_kyuuhai": "九种九牌",
        "suufon_renda": "四风连打",
        "suukantsu": "四杠散了",
        "suucha_riichi": "四家立直",
    }.get(reason, "流局")


def build_round_seed_stream(randomizer, count=16):
    return [randomizer.randint(100000, 999999) for _ in range(count)]


def actor_just_drew(snapshot, actor):
    if snapshot.get("phase") != "discard":
        return False
    if int(snapshot.get("currentActor", -1)) != int(actor):
        return False
    action_history = snapshot.get("actionHistory") or []
    if not action_history:
        return False
    last_action = action_history[-1]
    return last_action.get("type") == "tsumo" and int(last_action.get("actor", -1)) == int(actor)


def get_forbidden_discard_families_after_self_furo(snapshot, actor):
    history = snapshot.get("actionHistory") or []
    if not history:
        return set()

    last_action = history[-1]
    if int(last_action.get("actor", -1)) != int(actor):
        return set()

    action_type = str(last_action.get("type") or "")
    if action_type not in ("chi", "pon"):
        return set()

    called_tile = str(last_action.get("pai") or "")
    called_family = normalize_tile_family(called_tile)
    forbidden = {called_family}

    if action_type != "chi":
        return forbidden

    normalized = called_family
    if len(normalized) != 2 or normalized[0] not in "123456789" or normalized[1] not in ("m", "p", "s"):
        return forbidden

    consumed = list(last_action.get("consumed") or [])
    consumed_numbers = []
    for tile in consumed:
        family = normalize_tile_family(tile)
        if len(family) != 2 or family[0] not in "123456789" or family[1] != normalized[1]:
            continue
        consumed_numbers.append(int(family[0]))

    if len(consumed_numbers) != 2:
        return forbidden

    consumed_numbers.sort()
    if abs(consumed_numbers[0] - consumed_numbers[1]) != 1:
        return forbidden

    called_number = int(normalized[0])
    suit = normalized[1]
    min_num = consumed_numbers[0]
    max_num = consumed_numbers[1]

    if called_number < min_num:
        bigger = max_num + 1
        if bigger <= 9:
            forbidden.add(f"{bigger}{suit}")
    elif called_number > max_num:
        smaller = min_num - 1
        if smaller >= 1:
            forbidden.add(f"{smaller}{suit}")

    return forbidden


def get_reaction_hand_consumed(response, called_tile, normalize_tile_family):
    action_type = str(response.get("type") or "")
    expected = get_reaction_expected_hand_count(action_type)
    consumed = list(response.get("consumed") or [])
    if expected is None:
        return consumed
    if len(consumed) <= expected:
        return consumed

    called_family = normalize_tile_family(called_tile)
    filtered = consumed[:]
    for index, tile in enumerate(consumed):
        if normalize_tile_family(tile) == called_family:
            filtered = consumed[:index] + consumed[index + 1:]
            break
    if len(filtered) > expected:
        filtered = filtered[:expected]
    return filtered


def resolve_reaction_hand_consumed(hand, response, called_tile, normalize_tile_family):
    action_type = str(response.get("type") or "")
    expected = get_reaction_expected_hand_count(action_type) or 0
    targets = get_reaction_hand_consumed(response, called_tile, normalize_tile_family)
    available = list(hand)
    resolved = []

    def pop_matching(target):
        # Prefer red tiles (e.g. 5mr over 5m)
        candidates = []
        for index, tile in enumerate(available):
            if tile == target:
                candidates.append((index, tile))
        if not candidates:
            normalized_target = normalize_tile_family(target)
            for index, tile in enumerate(available):
                if normalize_tile_family(tile) == normalized_target:
                    candidates.append((index, tile))
        if not candidates:
            return None
        candidates.sort(key=lambda item: (0 if item[1].endswith("r") else 1, item[0]))
        best_index, _best_tile = candidates[0]
        return available.pop(best_index)

    for target in targets:
        matched = pop_matching(target)
        if matched is not None:
            resolved.append(matched)

    if len(resolved) < expected:
        called_family = normalize_tile_family(called_tile)
        while len(resolved) < expected:
            fallback = next((tile for tile in available if normalize_tile_family(tile) == called_family), None)
            if fallback is None:
                break
            available.remove(fallback)
            resolved.append(fallback)

    return resolved


def get_reaction_expected_hand_count(action_type):
    return {
        "chi": 2,
        "pon": 2,
        "daiminkan": 3,
    }.get(str(action_type or ""))
