import copy
from itertools import combinations, product

import snapshot_state
from service_helpers import (
    actor_just_drew,
    get_forbidden_discard_families_after_self_furo,
    normalize_tile_family,
    sort_tiles,
    unique_preserving_order,
)
from settlement import (
    can_declare_ron,
    get_valid_riichi_discards,
)


def normalize_seat(value):
    seat = int(value)
    if seat < 0 or seat > 3:
        raise ValueError("Seat must be between 0 and 3.")
    return seat


def can_resolve_hora_reaction(snapshot, winner, target, win_tile):
    del target, win_tile
    try:
        return bool(can_declare_ron(snapshot, int(winner)))
    except Exception:  # pylint: disable=broad-except
        return False


def build_legal_actions(
    snapshot,
    controlled_seat,
    *,
    build_player_state,
    can_declare_tsumo,
    can_declare_riichi,
    can_declare_kyuushu_kyuuhai,
    get_ankan_candidates,
    get_legal_kan_actions,
    build_local_reaction_actions,
    debug=None,
):
    controlled_seat = normalize_seat(controlled_seat)

    if snapshot["phase"] == "discard":
        actor = snapshot["currentActor"]
        if actor != controlled_seat:
            if debug is not None:
                debug(f"[FLOW] build_legal_actions SKIP phase=discard actor={actor} controlled={controlled_seat}")
            return []

        is_riichi = snapshot.get("riichiAccepted", [False, False, False, False])[actor]

        if is_riichi and snapshot.get("riichiDiscardState") == "ankan_choice":
            kan_actions = get_legal_kan_actions(snapshot, actor)
            valid_candidates = set(get_ankan_candidates(snapshot, actor))
            actions = [
                {
                    "id": f"kan:{entry['variant']}",
                    "type": entry["type"],
                    "variant": entry["variant"],
                    "actor": actor,
                    "label": entry["label"],
                    "pai": entry.get("pai"),
                    "consumed": copy.deepcopy(entry.get("consumed") or []),
                }
                for entry in kan_actions
                if entry["type"] == "ankan"
                and normalize_tile_family(entry.get("pai", "")) in valid_candidates
            ]
            if actions:
                action_history = snapshot.get("actionHistory") or []
                last_action = action_history[-1] if action_history else {}
                drawn_tile = (
                    str(last_action.get("pai") or "")
                    if last_action.get("type") == "tsumo"
                    and int(last_action.get("actor", -1)) == actor
                    else ""
                )
                actions.append({
                    "id": "riichi_ankan:skip",
                    "type": "none",
                    "variant": "skip_ankan",
                    "actor": actor,
                    "pai": drawn_tile,
                    "tsumogiri": True,
                    "label": "Skip (Tsumogiri)",
                })
            return actions

        if is_riichi:
            if snapshot.get("riichiDiscardState") == "pending_pause":
                return []
            if actor_just_drew(snapshot, actor) and can_declare_tsumo(snapshot, actor):
                hand = snapshot.get("hands", [[], [], [], []])[actor]
                action_history = snapshot.get("actionHistory") or []
                drawn_tile = ""
                if action_history:
                    last_action = action_history[-1]
                    if last_action.get("type") == "tsumo" and int(last_action.get("actor", -1)) == actor:
                        drawn_tile = str(last_action.get("pai") or "")
                if not drawn_tile and hand:
                    drawn_tile = hand[-1]
                actions = [
                    {
                        "id": "hora:tsumo",
                        "type": "hora",
                        "variant": "tsumo",
                        "actor": actor,
                        "label": "Tsumo",
                    }
                ]
                if drawn_tile and drawn_tile in hand:
                    actions.append({
                        "id": f"dahai:{drawn_tile}",
                        "type": "dahai",
                        "actor": actor,
                        "pai": drawn_tile,
                        "label": f"Tsumogiri {drawn_tile}",
                        "tsumogiri": True,
                    })
                return actions
            return []

        can_use_drawn_tile_options = actor_just_drew(snapshot, actor)

        hand = list(snapshot.get("hands", [[], [], [], []])[actor])
        drawn_tile = ""
        if can_use_drawn_tile_options:
            action_history = snapshot.get("actionHistory") or []
            if action_history:
                last_action = action_history[-1]
                if last_action.get("type") == "tsumo" and int(last_action.get("actor", -1)) == actor:
                    drawn_tile = str(last_action.get("pai") or "")
            if not drawn_tile and hand:
                drawn_tile = hand[-1]

        unique_tiles = unique_preserving_order(hand)
        forbidden_families = get_forbidden_discard_families_after_self_furo(snapshot, actor)
        actions = []
        for tile in unique_tiles:
            if normalize_tile_family(tile) in forbidden_families:
                continue
            count_in_hand = hand.count(tile)
            is_drawn_tile = (
                can_use_drawn_tile_options
                and drawn_tile
                and str(tile) == str(drawn_tile)
            )
            # When the drawn tile face has duplicates, split into tsumogiri vs hand-discard
            if is_drawn_tile and count_in_hand > 1:
                actions.append({
                    "id": f"dahai:{tile}:tsumo",
                    "type": "dahai",
                    "actor": actor,
                    "pai": tile,
                    "label": f"Tsumogiri {tile}",
                    "tsumogiri": True,
                })
                # Hand-discard of the old copy (not the drawn one)
                actions.append({
                    "id": f"dahai:{tile}",
                    "type": "dahai",
                    "actor": actor,
                    "pai": tile,
                    "label": f"Discard {tile}",
                })
            else:
                action = {
                    "id": f"dahai:{tile}",
                    "type": "dahai",
                    "actor": actor,
                    "pai": tile,
                    "label": f"Discard {tile}",
                }
                if is_drawn_tile:
                    action["label"] = f"Tsumogiri {tile}"
                    action["tsumogiri"] = True
                actions.append(action)
        player_state = build_player_state(snapshot, actor) if can_use_drawn_tile_options else None
        if can_use_drawn_tile_options and can_declare_tsumo(snapshot, actor, state=player_state):
            actions.append(
                {
                    "id": "hora:tsumo",
                    "type": "hora",
                    "variant": "tsumo",
                    "actor": actor,
                    "label": "Tsumo",
                }
            )
        if can_use_drawn_tile_options:
            for entry in get_legal_kan_actions(snapshot, actor):
                action = {
                    "id": f"kan:{entry['variant']}",
                    "type": entry["type"],
                    "variant": entry["variant"],
                    "actor": actor,
                    "label": entry["label"],
                    "pai": entry.get("pai"),
                    "consumed": copy.deepcopy(entry.get("consumed") or []),
                }
                actions.append(action)
        if can_use_drawn_tile_options and can_declare_riichi(snapshot, actor, state=player_state):
            actions.append(
                {
                    "id": "reach:declare",
                    "type": "reach",
                    "variant": "declare",
                    "actor": actor,
                    "label": "Cancel Riichi" if snapshot.get("pendingRiichiSeat") == actor else "Riichi",
                }
            )
        if can_declare_kyuushu_kyuuhai(snapshot, actor, player_state=player_state):
            actions.append(
                {
                    "id": "ryukyoku:kyuushu_kyuuhai",
                    "type": "ryukyoku",
                    "variant": "kyuushu_kyuuhai",
                    "actor": actor,
                    "label": "Abortive Draw",
                }
            )
        return actions

    if snapshot["phase"] in ("reaction_window", "kan_reaction_window"):
        reaction_window = snapshot.get("reactionWindow") if snapshot["phase"] == "reaction_window" else snapshot.get("kanReactionWindow")
        reaction_window = reaction_window or {}
        resolved_seats = {
            int(seat)
            for seat in reaction_window.get("resolvedSeats", [])
            if isinstance(seat, int) or str(seat).isdigit()
        }
        if controlled_seat in resolved_seats:
            return []
        controlled_reaction = next((item for item in reaction_window.get("reactions", []) if item.get("seat") == controlled_seat), None)
        if not controlled_reaction:
            return []
        return build_local_reaction_actions(snapshot, controlled_seat)

    if snapshot["phase"] == "reach_declaration":
        actor = snapshot["currentActor"]
        if actor != controlled_seat:
            return []
        valid_families = set(get_valid_riichi_discards(snapshot, actor))
        hand = list(snapshot["hands"][actor])
        unique_tiles = unique_preserving_order(hand)
        action_history = snapshot.get("actionHistory") or []
        drawn_tile = ""
        if action_history:
            last_action = action_history[-1]
            if last_action.get("type") == "tsumo" and int(last_action.get("actor", -1)) == actor:
                drawn_tile = str(last_action.get("pai") or "")
        if not drawn_tile and hand:
            drawn_tile = str(hand[-1])
        actions = []
        for tile in unique_tiles:
            if normalize_tile_family(tile) not in valid_families:
                continue
            is_drawn_tile = bool(drawn_tile and tile == drawn_tile)
            if is_drawn_tile and hand.count(tile) > 1:
                actions.append({
                    "id": f"dahai:{tile}:tsumo",
                    "type": "dahai",
                    "actor": actor,
                    "pai": tile,
                    "label": f"Riichi Tsumogiri {tile}",
                    "riichi": True,
                    "tsumogiri": True,
                })
                actions.append({
                    "id": f"dahai:{tile}",
                    "type": "dahai",
                    "actor": actor,
                    "pai": tile,
                    "label": f"Riichi Discard {tile}",
                    "riichi": True,
                })
                continue
            action = {
                "id": f"dahai:{tile}",
                "type": "dahai",
                "actor": actor,
                "pai": tile,
                "label": f"Riichi Discard {tile}",
                "riichi": True,
            }
            if is_drawn_tile:
                action["tsumogiri"] = True
            actions.append(action)
        return actions

    return []


def get_legal_kan_actions(snapshot, actor):
    snapshot_state.sync(snapshot)
    if not actor_just_drew(snapshot, actor):
        return []
    hand = list(snapshot.get("hands", [[], [], [], []])[actor])
    melds = list(snapshot.get("melds", [[], [], [], []])[actor])
    actions = []

    grouped_hand = {}
    for tile in hand:
        grouped_hand.setdefault(normalize_tile_family(tile), []).append(tile)

    for family, tiles in grouped_hand.items():
        if len(tiles) >= 4:
            actual_tiles = tiles[:4]
            actions.append(
                {
                    "type": "ankan",
                    "variant": f"ankan:{family}",
                    "pai": actual_tiles[0],
                    "consumed": copy.deepcopy(actual_tiles),
                    "label": f"Closed Kan {family}",
                }
            )

    for meld in melds:
        if meld.get("type") != "pon":
            continue
        family = normalize_tile_family(str(meld.get("pai") or ""))
        matching_tiles = grouped_hand.get(family) or []
        if not matching_tiles:
            continue
        pon_tiles = list(meld.get("consumed") or [])
        consumed = copy.deepcopy((pon_tiles + [matching_tiles[0]])[:3])
        actions.append(
            {
                "type": "kakan",
                "variant": f"kakan:{family}",
                "pai": matching_tiles[0],
                "consumed": consumed,
                "label": f"Add Kan {family}",
            }
        )

    return actions


def _unique_consumed_combinations(tiles, count):
    unique = {}
    for selected in combinations(tiles, count):
        canonical = tuple(sort_tiles(list(selected)))
        unique[canonical] = list(canonical)
    return list(unique.values())


def _build_local_chi_actions(snapshot, actor, called_tile):
    normalized = normalize_tile_family(str(called_tile or ""))
    if len(normalized) != 2 or normalized[0] not in "123456789" or normalized[1] not in ("m", "p", "s"):
        return []

    hand = list(snapshot.get("hands", [[], [], [], []])[actor])
    number = int(normalized[0])
    suit = normalized[1]
    actions = []
    variants = [
        ("chi_low", [number + 1, number + 2]),
        ("chi_mid", [number - 1, number + 1]),
        ("chi_high", [number - 2, number - 1]),
    ]
    for variant, needed_numbers in variants:
        if any(value < 1 or value > 9 for value in needed_numbers):
            continue
        exact_options = []
        for target_number in needed_numbers:
            family = f"{target_number}{suit}"
            matches = unique_preserving_order(
                tile for tile in hand
                if normalize_tile_family(tile) == family
            )
            if not matches:
                exact_options = []
                break
            exact_options.append(matches)
        if not exact_options:
            continue
        for selected in product(*exact_options):
            consumed = list(selected)
            consumed_id = ",".join(consumed)
            actions.append({
                "id": f"reaction:{variant}:{consumed_id}",
                "type": "chi",
                "variant": variant,
                "actor": actor,
                "label": variant,
                "pai": called_tile,
                "consumed": copy.deepcopy(consumed),
            })
    return actions


def _build_local_reaction_actions(snapshot, actor, *, can_resolve_hora_reaction):
    if snapshot["phase"] == "kan_reaction_window":
        pending_kan = snapshot.get("pendingKan") or {}
        kan_actor = int(pending_kan.get("actor", snapshot.get("currentActor", 0)))
        kan_tile = str(pending_kan.get("pai") or "")
        legal_actions = []
        if can_resolve_hora_reaction(snapshot, actor, kan_actor, kan_tile):
            legal_actions.append(
                {
                    "id": "reaction:hora",
                    "type": "hora",
                    "variant": "hora",
                    "actor": actor,
                    "label": "Ron",
                    "pai": kan_tile,
                }
            )
        if legal_actions:
            legal_actions.append(
                {
                    "id": "reaction:none",
                    "type": "none",
                    "variant": "none",
                    "actor": actor,
                    "label": "Pass",
                }
            )
        return legal_actions

    reaction_window = snapshot.get("reactionWindow") or {}
    discard = reaction_window.get("discard") or {}
    discard_actor = int(discard.get("actor", -1))
    called_tile = str(discard.get("pai") or "")
    target_actor = int(discard.get("targetActor", -1))
    legal_actions = []

    if can_resolve_hora_reaction(snapshot, actor, discard_actor, called_tile):
        legal_actions.append(
            {
                "id": "reaction:hora",
                "type": "hora",
                "variant": "hora",
                "actor": actor,
                "label": "Ron",
                "pai": called_tile,
            }
        )

    if not snapshot.get("riichiAccepted", [False, False, False, False])[actor]:
        hand = list(snapshot.get("hands", [[], [], [], []])[actor])
        matching_tiles = [tile for tile in hand if normalize_tile_family(tile) == normalize_tile_family(called_tile)]
        for consumed in _unique_consumed_combinations(matching_tiles, 2):
            consumed_id = ",".join(consumed)
            legal_actions.append({
                    "id": f"reaction:pon:{consumed_id}",
                    "type": "pon",
                    "variant": "pon",
                    "actor": actor,
                    "label": "Pon",
                    "pai": called_tile,
                    "consumed": copy.deepcopy(consumed),
                })
        for consumed in _unique_consumed_combinations(matching_tiles, 3):
            consumed_id = ",".join(consumed)
            legal_actions.append({
                    "id": f"reaction:daiminkan:{consumed_id}",
                    "type": "daiminkan",
                    "variant": "daiminkan",
                    "actor": actor,
                    "label": "Kan",
                    "pai": called_tile,
                    "consumed": copy.deepcopy(consumed),
                })
        if actor == target_actor:
            legal_actions.extend(_build_local_chi_actions(snapshot, actor, called_tile))

    if legal_actions:
        legal_actions.append(
            {
                "id": "reaction:none",
                "type": "none",
                "variant": "none",
                "actor": actor,
                "label": "Pass",
            }
        )
    return legal_actions
