"""In-round snapshot mutations for draws, discards, kans and reactions."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Callable

from . import legal_actions
from . import snapshot_state
from .hora_calculation import compute_hora_result
from .service_helpers import (
    get_reaction_expected_hand_count,
    get_reaction_hand_consumed,
    normalize_tile_family,
    resolve_reaction_hand_consumed,
    sort_tiles,
)


@dataclass
class RoundActionDependencies:
    controlled_seat: Callable[[], int]
    action_weight_path: Callable[[], str]
    choose_ai_action: Callable[..., dict[str, Any]]


class RoundActions:
    """Apply action-level mutations to a supplied round snapshot."""

    def __init__(self, round_progression: Any, dependencies: RoundActionDependencies) -> None:
        self.round_progression = round_progression
        self.dependencies = dependencies

    def draw_one(self, snapshot, seat):
        snapshot_state.sync(snapshot)
        return self.draw_tile(snapshot, seat, source="wall")


    def draw_tile(self, snapshot, seat, source="wall"):
        snapshot_state.sync(snapshot)
        if source == "rinshan":
            if not self.round_progression.has_rinshan_draw_available(snapshot):
                raise ValueError("Rinshan exhausted.")
            tile = snapshot["rinshanWall"][0]
            snapshot["rinshanWall"] = snapshot["rinshanWall"][1:]
            # 开杠摸岭上牌：王牌区向牌山区扩张一格，牌山最后一张变为不可摸
            if snapshot["drawIndex"] < len(snapshot["wall"]):
                snapshot["wall"] = snapshot["wall"][:-1]
        else:
            if snapshot["drawIndex"] >= len(snapshot["wall"]):
                raise ValueError("Wall exhausted.")
            tile = snapshot["wall"][snapshot["drawIndex"]]
            snapshot["drawIndex"] += 1
        snapshot["hands"][seat].append(tile)
        snapshot["hands"][seat] = sort_tiles(snapshot["hands"][seat])
        snapshot["lastAction"] = {
            "type": "tsumo",
            "actor": seat,
            "pai": tile,
            "source": source,
        }
        snapshot["actionHistory"].append(
            {
                "type": "tsumo",
                "actor": seat,
                "pai": tile,
                "tsumogiri": False,
                "source": source,
            }
        )
        snapshot_state.persist(snapshot)
        return tile


    def has_pending_riichi(self, snapshot, actor):
        return snapshot.get("pendingRiichiSeat") == actor and not snapshot["riichiAccepted"][actor]


    def stage_riichi_discard(self, snapshot, actor, tile, tsumogiri):
        next_actor = (actor + 1) % 4
        snapshot["pendingRiichiDiscard"] = {
            "actor": actor,
            "pai": tile,
            "tsumogiri": tsumogiri,
            "targetActor": next_actor,
            "riichi": True,
        }
        snapshot["reactionWindow"] = None
        snapshot["lastAction"] = {
            "type": "reach",
            "actor": actor,
        }
        snapshot["phase"] = "reach_declaration"
        snapshot_state.persist(snapshot)


    def materialize_reach_discard(self, snapshot):
        snapshot_state.sync(snapshot)
        staged = snapshot.get("pendingRiichiDiscard")
        if not staged:
            return False
        actor = staged["actor"]
        tile = staged["pai"]
        return self.materialize_reach_declaration_discard(snapshot, actor, tile, bool(staged.get("tsumogiri", False)))


    def materialize_reach_declaration_discard(self, snapshot, actor, tile, tsumogiri):
        snapshot_state.sync(snapshot)
        if tile in snapshot["hands"][actor]:
            snapshot["hands"][actor].remove(tile)
        self.round_progression.promote_delayed_dora_reveal(snapshot)
        snapshot["pendingDiscard"] = {
            "actor": actor,
            "pai": tile,
            "tsumogiri": bool(tsumogiri),
            "targetActor": (actor + 1) % 4,
            "riichi": True,
        }
        snapshot["pendingRiichiDiscard"] = None
        snapshot["reactionWindow"] = None
        snapshot["lastAction"] = {
            "type": "dahai",
            "actor": actor,
            "pai": tile,
            "tsumogiri": bool(tsumogiri),
            "riichi": True,
        }
        snapshot["actionHistory"].append(
            {
                "type": "dahai",
                "actor": actor,
                "pai": tile,
                "tsumogiri": bool(tsumogiri),
                "riichi": True,
            }
        )
        snapshot["turn"] += 1
        snapshot["currentActor"] = actor
        snapshot["phase"] = "reaction_window"
        snapshot_state.persist(snapshot)
        return True


    def apply_discard(self, snapshot, actor, tile, from_drawn=None):
        snapshot_state.sync(snapshot)
        if tile not in snapshot["hands"][actor]:
            raise ValueError(f"Tile {tile} not found in actor {actor} hand.")
        ippatsu_flags = self.round_progression.ensure_ippatsu_flags(snapshot)
        tsumogiri = False
        if from_drawn is not None:
            tsumogiri = bool(from_drawn)
        elif snapshot["actionHistory"]:
            last_action = snapshot["actionHistory"][-1]
            tsumogiri = last_action.get("type") == "tsumo" and last_action.get("actor") == actor and last_action.get("pai") == tile
        if self.has_pending_riichi(snapshot, actor) and not snapshot["riichiDeclared"][actor]:
            snapshot["riichiDeclared"][actor] = True
            snapshot["actionHistory"].append(
                {
                    "type": "reach",
                    "actor": actor,
                }
            )
        hand = snapshot["hands"][actor]
        if tsumogiri and hand.count(tile) > 1:
            # Remove the DRAWN copy (last occurrence in sorted hand — self.draw_tile
            # appends then sorts; Python stable sort keeps it after the old copy)
            last_idx = len(hand) - 1 - hand[::-1].index(tile)
            hand.pop(last_idx)
        else:
            hand.remove(tile)
        self.round_progression.promote_delayed_dora_reveal(snapshot)
        if self.has_pending_riichi(snapshot, actor):
            self.stage_riichi_discard(snapshot, actor, tile, tsumogiri)
            return

        if snapshot.get("riichiAccepted", [False, False, False, False])[actor] and ippatsu_flags[actor]:
            ippatsu_flags[actor] = False

        next_actor = (actor + 1) % 4
        snapshot["pendingDiscard"] = {
            "actor": actor,
            "pai": tile,
            "tsumogiri": tsumogiri,
            "targetActor": next_actor,
            "riichi": False,
        }
        snapshot["reactionWindow"] = None
        snapshot["lastAction"] = {
            "type": "dahai",
            "actor": actor,
            "pai": tile,
            "tsumogiri": tsumogiri,
            "riichi": False,
        }
        snapshot["actionHistory"].append(
            {
                "type": "dahai",
                "actor": actor,
                "pai": tile,
                "tsumogiri": tsumogiri,
                "riichi": False,
            }
        )
        snapshot["turn"] += 1
        snapshot["currentActor"] = actor
        snapshot["phase"] = "reaction_window"
        snapshot_state.persist(snapshot)


    def resolve_discard_tsumogiri(self, snapshot, actor, tile, requested=None):
        """Normalize engine intent against the actual drawn tile and hand contents."""
        action_history = snapshot.get("actionHistory") or []
        last_action = action_history[-1] if action_history else {}
        is_drawn_tile = (
            last_action.get("type") == "tsumo"
            and last_action.get("actor") == actor
            and str(last_action.get("pai") or "") == str(tile or "")
        )
        if not is_drawn_tile:
            return False

        hand = snapshot.get("hands", [[], [], [], []])[actor]
        if hand.count(tile) <= 1:
            return True
        if isinstance(requested, bool):
            return requested
        return True

    def get_reaction_priority(self, action_type):
        priorities = {
            "none": 0,
            "chi": 1,
            "pon": 2,
            "daiminkan": 3,
            "hora": 4,
        }
        return priorities.get(action_type, -1)


    def can_resolve_hora_reaction(self, snapshot, winner, target, win_tile):
        return legal_actions.can_resolve_hora_reaction(
            snapshot,
            winner,
            target,
            win_tile,
        )


    def normalize_called_tile(self, snapshot, actor, tile):
        if tile in snapshot["hands"][actor]:
            return tile

        normalized_candidates = {
            "5m": ["5m", "5mr"],
            "5p": ["5p", "5pr"],
            "5s": ["5s", "5sr"],
        }.get(tile, [tile])

        for candidate in normalized_candidates:
            if candidate in snapshot["hands"][actor]:
                return candidate

        return tile


    def remove_consumed_tiles(self, snapshot, actor, consumed):
        snapshot_state.sync(snapshot)
        for tile in consumed:
            actual_tile = self.normalize_called_tile(snapshot, actor, tile)
            if actual_tile not in snapshot["hands"][actor]:
                raise ValueError(f"Consumed tile {tile} not found in actor {actor} hand.")
            snapshot["hands"][actor].remove(actual_tile)
        snapshot_state.persist(snapshot)


    def remove_single_tile(self, snapshot, actor, tile):
        snapshot_state.sync(snapshot)
        actual_tile = self.normalize_called_tile(snapshot, actor, tile)
        if actual_tile not in snapshot["hands"][actor]:
            raise ValueError(f"Tile {tile} not found in actor {actor} hand.")
        snapshot["hands"][actor].remove(actual_tile)
        snapshot_state.persist(snapshot)
        return actual_tile


    def apply_self_kan_action(self, snapshot, response):
        snapshot_state.sync(snapshot)
        actor = int(response["actor"])
        action_type = str(response.get("type") or "")
        # The riichi ankan prompt is a one-shot state. Carrying it into the
        # rinshan draw would expose a second, invalid skip prompt.
        snapshot["riichiDiscardState"] = None
        self.round_progression.clear_all_ippatsu(snapshot)
        self.round_progression.promote_delayed_dora_reveal(snapshot)
        snapshot_state.persist(snapshot)
        if action_type == "ankan":
            consumed = response.get("consumed", [])
            self.remove_consumed_tiles(snapshot, actor, consumed)
            snapshot["melds"][actor].append(copy.deepcopy(response))
        elif action_type == "kakan":
            self.start_kakan_reaction_window(snapshot, response)
            return
        elif action_type == "daiminkan":
            consumed = response.get("consumed", [])
            self.remove_consumed_tiles(snapshot, actor, consumed)
            snapshot["melds"][actor].append(copy.deepcopy(response))
        else:
            raise ValueError(f"Unsupported kan action: {action_type}")

        snapshot["lastAction"] = copy.deepcopy(response)
        snapshot["actionHistory"].append(copy.deepcopy(response))
        snapshot_state.persist(snapshot)
        if action_type == "ankan":
            self.round_progression.queue_dora_reveal(snapshot, after_action=False)
        else:
            self.round_progression.queue_dora_reveal(snapshot, after_action=True)
        snapshot["currentActor"] = actor
        snapshot["pendingRinshanDraw"] = True
        snapshot["phase"] = "draw_or_discard"
        snapshot_state.persist(snapshot)


    def build_kan_reaction_window(self, snapshot):
        snapshot_state.sync(snapshot)
        pending_kan = snapshot.get("pendingKan")
        if not pending_kan:
            return None

        actor = int(pending_kan["actor"])
        seats_in_order = [((actor + offset) % 4) for offset in range(1, 4)]
        reactions = []
        reaction_thinking_time_s = 0.0

        for seat in seats_in_order:
            model_path = self.dependencies.action_weight_path()
            try:
                response = self.dependencies.choose_ai_action(snapshot, seat, model_path, accumulate_thinking=False)
            except Exception as error:  # pylint: disable=broad-except
                response = {
                    "type": "none",
                    "actor": seat,
                    "variant": "none",
                    "label": "Pass",
                    "meta": {
                        "skip_reason": "kan_reaction_error",
                        "error": str(error),
                    },
                }
            reaction_thinking_time_s = max(
                reaction_thinking_time_s,
                float(((response.get("meta") or {}).get("thinking_time_s") or 0.0)),
            )
            reaction_type = response.get("type", "none")
            if reaction_type == "hora":
                if not self.can_resolve_hora_reaction(snapshot, seat, actor, pending_kan.get("pai")):
                    response = {"type": "none", "actor": seat, "variant": "none", "label": "Pass"}
                    reaction_type = "none"
            else:
                response = {"type": "none", "actor": seat, "variant": "none", "label": "Pass"}
                reaction_type = "none"
            reactions.append(
                {
                    "seat": seat,
                    "response": response,
                    "priority": self.get_reaction_priority(reaction_type),
                }
            )

        selected = max(reactions, key=lambda item: (item["priority"], -seats_in_order.index(item["seat"])))
        return {
            "kan": copy.deepcopy(pending_kan),
            "reactions": reactions,
            "selected": copy.deepcopy(selected),
            "thinkingTimeS": reaction_thinking_time_s,
        }


    def start_kakan_reaction_window(self, snapshot, response):
        snapshot_state.sync(snapshot)
        actor = int(response["actor"])
        pai = str(response.get("pai") or "")
        self.remove_single_tile(snapshot, actor, pai)
        consumed = None
        for meld in snapshot["melds"][actor]:
            if meld.get("type") == "pon" and str(meld.get("pai") or "") == pai:
                consumed = [str(tile) for tile in copy.deepcopy(meld.get("consumed") or [])]
                while len(consumed) < 3:
                    consumed.append(pai)
                break
        if not consumed:
            consumed = [pai, pai, pai]
        response = copy.deepcopy(response)
        response["consumed"] = consumed
        pending_kan = copy.deepcopy(response)
        pending_kan["source"] = "kakan"
        snapshot["pendingKan"] = pending_kan
        snapshot["pendingDiscard"] = None
        snapshot["reactionWindow"] = None
        snapshot["lastAction"] = copy.deepcopy(response)
        snapshot["actionHistory"].append(copy.deepcopy(response))
        snapshot["currentActor"] = actor
        snapshot["phase"] = "kan_reaction_window"
        snapshot_state.persist(snapshot)
        snapshot["kanReactionWindow"] = self.build_kan_reaction_window(snapshot)
        snapshot_state.persist(snapshot)


    def finalize_kakan_resolution(self, snapshot):
        snapshot_state.sync(snapshot)
        pending_kan = copy.deepcopy(snapshot.get("pendingKan"))
        if not pending_kan:
            return

        actor = int(pending_kan["actor"])
        pai = str(pending_kan.get("pai") or "")
        upgraded = False
        for meld in snapshot["melds"][actor]:
            if meld.get("type") == "pon" and str(meld.get("pai") or "") == pai:
                meld["type"] = "kakan"
                meld["kakan"] = pai
                meld["consumed"] = copy.deepcopy(pending_kan.get("consumed") or [pai, pai, pai])
                upgraded = True
                break
        if not upgraded:
            snapshot["melds"][actor].append(copy.deepcopy(pending_kan))

        snapshot["pendingKan"] = None
        snapshot["kanReactionWindow"] = None
        snapshot_state.persist(snapshot)
        self.round_progression.queue_dora_reveal(snapshot, after_action=True)
        snapshot["pendingRinshanDraw"] = True
        snapshot["currentActor"] = actor
        snapshot["phase"] = "draw_or_discard"
        snapshot_state.persist(snapshot)


    def evaluate_reactions(self, snapshot):
        snapshot_state.sync(snapshot)
        pending_discard = snapshot.get("pendingDiscard")
        if not pending_discard:
            return None

        discard_actor = pending_discard["actor"]
        seats_in_order = [((discard_actor + offset) % 4) for offset in range(1, 4)]
        reactions = []
        reaction_thinking_time_s = 0.0

        for seat in seats_in_order:
            if seat == self.dependencies.controlled_seat():
                response = {"type": "none", "actor": seat, "variant": "none", "label": "Pass"}
            else:
                model_path = self.dependencies.action_weight_path()
                try:
                    response = self.dependencies.choose_ai_action(snapshot, seat, model_path, accumulate_thinking=False)
                except Exception as error:  # pylint: disable=broad-except
                    response = {
                        "type": "none",
                        "actor": seat,
                        "variant": "none",
                        "label": "Pass",
                        "meta": {
                            "skip_reason": "reaction_error",
                            "error": str(error),
                        },
                    }
            reaction_thinking_time_s = max(
                reaction_thinking_time_s,
                float(((response.get("meta") or {}).get("thinking_time_s") or 0.0)),
            )
            reaction_type = response.get("type", "none")
            if seat != pending_discard["targetActor"] and reaction_type == "chi":
                response = {"type": "none", "actor": seat, "meta": {"skip_reason": "non_adjacent_chi"}}
                reaction_type = "none"
            elif reaction_type == "hora":
                if not self.can_resolve_hora_reaction(snapshot, seat, discard_actor, pending_discard["pai"]):
                    response = {
                        "type": "none",
                        "actor": seat,
                        "variant": "none",
                        "label": "Pass",
                        "meta": {
                            "skip_reason": "invalid_hora_reaction",
                            "original": copy.deepcopy(response),
                        },
                    }
                    reaction_type = "none"
            elif (
                reaction_type in ("chi", "pon", "daiminkan")
                and snapshot.get("riichiAccepted", [False, False, False, False])[seat]
            ):
                response = {
                    "type": "none",
                    "actor": seat,
                    "variant": "none",
                    "label": "Pass",
                    "meta": {
                        "skip_reason": "riichi_blocked",
                        "original": copy.deepcopy(response),
                    },
                }
                reaction_type = "none"
            elif reaction_type in ("chi", "pon", "daiminkan"):
                resolved_consumed = resolve_reaction_hand_consumed(
                    snapshot["hands"][seat],
                    response,
                    pending_discard["pai"],
                    normalize_tile_family,
                )
                expected_count = get_reaction_expected_hand_count(reaction_type) or 0
                if len(resolved_consumed) != expected_count:
                    response = {
                        "type": "none",
                        "actor": seat,
                        "variant": "none",
                        "label": "Pass",
                        "meta": {
                            "skip_reason": "invalid_reaction_consumed",
                            "original": copy.deepcopy(response),
                        },
                    }
                    reaction_type = "none"
                else:
                    response = copy.deepcopy(response)
                    response["consumed"] = copy.deepcopy(resolved_consumed)
            reactions.append(
                {
                    "seat": seat,
                    "response": response,
                    "priority": self.get_reaction_priority(reaction_type),
                }
            )

        selected = max(reactions, key=lambda item: (item["priority"], -seats_in_order.index(item["seat"])))

        return {
            "discard": copy.deepcopy(pending_discard),
            "reactions": reactions,
            "selected": copy.deepcopy(selected),
            "thinkingTimeS": reaction_thinking_time_s,
        }


    def finalize_pending_discard_to_river(self, snapshot):
        snapshot_state.sync(snapshot)
        pending_discard = snapshot.get("pendingDiscard")
        if not pending_discard:
            return
        snapshot["rivers"][pending_discard["actor"]].append(pending_discard["pai"])
        snapshot["pendingDiscard"] = None
        snapshot_state.persist(snapshot)


    def apply_reaction_action(self, snapshot, selected):
        snapshot_state.sync(snapshot)
        response = selected["response"]
        action_type = response.get("type")
        if snapshot.get("phase") == "kan_reaction_window":
            pending_kan = copy.deepcopy(snapshot.get("pendingKan") or {})
            if action_type == "none":
                self.finalize_kakan_resolution(snapshot)
                return

            if action_type == "hora":
                winner = int(response.get("actor", snapshot.get("currentActor", 0)))
                target = int(pending_kan.get("actor", snapshot.get("currentActor", 0)))
                win_tile = str(pending_kan.get("pai") or "")
                result = compute_hora_result(snapshot, winner, target, win_tile, False)
                snapshot["kanReactionWindow"] = None
                snapshot["pendingKan"] = None
                snapshot["pendingDiscard"] = None
                snapshot["reactionWindow"] = None
                snapshot["lastAction"] = {
                    "type": "hora",
                    "actor": winner,
                    "target": target,
                    "pai": win_tile,
                    "isTsumo": False,
                    "deltas": copy.deepcopy(result["deltas"]),
                    "uraMarkers": copy.deepcopy(result["uraMarkers"]),
                    "han": result.get("han"),
                    "fu": result.get("fu"),
                    "yaku": copy.deepcopy(result.get("yaku", [])),
                    "yakuDetails": copy.deepcopy(result.get("yakuDetails", [])),
                    "isOpenHand": result.get("isOpenHand"),
                    "cost": copy.deepcopy(result.get("cost", {})),
                }
                snapshot["actionHistory"].append(copy.deepcopy(response))
                snapshot["phase"] = "game_end"
                snapshot["currentActor"] = winner
                snapshot_state.persist(snapshot)
                return

            raise ValueError(f"Unsupported kan reaction action: {response}")

        discard = snapshot["pendingDiscard"]
        had_pending_riichi = snapshot.get("pendingRiichiSeat") is not None

        if action_type == "none":
            self.finalize_pending_discard_to_river(snapshot)
            snapshot["reactionWindow"] = None
            # Riichi is accepted before the next draw.
            if had_pending_riichi:
                self.round_progression.resolve_pending_riichi_acceptance(snapshot)
            if self.round_progression.maybe_mark_abortive_ryukyoku(snapshot):
                return
            snapshot["currentActor"] = discard["targetActor"]
            snapshot["phase"] = "draw_or_discard"
            snapshot_state.persist(snapshot)
            return

        self.finalize_pending_discard_to_river(snapshot)
        snapshot["reactionWindow"] = None

        if action_type == "hora":
            winner = int(response.get("actor", discard["targetActor"]))
            target = int(response.get("target", discard["targetActor"]))
            result = compute_hora_result(snapshot, winner, target, str(discard["pai"]), False)
            snapshot["lastAction"] = {
                "type": "hora",
                "actor": winner,
                "target": target,
                "pai": str(discard["pai"]),
                "isTsumo": False,
                "deltas": copy.deepcopy(result["deltas"]),
                "uraMarkers": copy.deepcopy(result["uraMarkers"]),
                "han": result.get("han"),
                "fu": result.get("fu"),
                "yaku": copy.deepcopy(result.get("yaku", [])),
                "yakuDetails": copy.deepcopy(result.get("yakuDetails", [])),
                "isOpenHand": result.get("isOpenHand"),
                "cost": copy.deepcopy(result.get("cost", {})),
            }
            snapshot["actionHistory"].append(copy.deepcopy(response))
            snapshot["phase"] = "game_end"
            snapshot["currentActor"] = response.get("actor", discard["targetActor"])
            snapshot_state.persist(snapshot)
            return

        # Riichi is accepted before processing the following meld.
        if had_pending_riichi:
            self.round_progression.resolve_pending_riichi_acceptance(snapshot)

        if action_type in ("pon", "chi"):
            actor = int(response.get("actor", -1))
            if actor >= 0 and snapshot.get("riichiAccepted", [False, False, False, False])[actor]:
                raise ValueError(f"Riichi player cannot {action_type}.")
            self.round_progression.clear_all_ippatsu(snapshot)
            actor = response["actor"]
            consumed = get_reaction_hand_consumed(response, discard["pai"], normalize_tile_family)
            resolved_consumed = resolve_reaction_hand_consumed(snapshot["hands"][actor], response, discard["pai"], normalize_tile_family)
            self.remove_consumed_tiles(snapshot, actor, resolved_consumed)
            response = copy.deepcopy(response)
            response["consumed"] = copy.deepcopy(resolved_consumed)
            response["from"] = int(discard["actor"])
            snapshot["melds"][actor].append(copy.deepcopy(response))
            snapshot["lastAction"] = copy.deepcopy(response)
            snapshot["actionHistory"].append(copy.deepcopy(response))
            snapshot["currentActor"] = actor
            snapshot["phase"] = "discard"
            snapshot_state.persist(snapshot)
            return

        if action_type == "daiminkan":
            actor = int(response.get("actor", -1))
            if actor >= 0 and snapshot.get("riichiAccepted", [False, False, False, False])[actor]:
                raise ValueError(f"Riichi player cannot daiminkan.")
            self.round_progression.clear_all_ippatsu(snapshot)
            response = copy.deepcopy(response)
            response["consumed"] = copy.deepcopy(
                resolve_reaction_hand_consumed(snapshot["hands"][int(response["actor"])], response, discard["pai"], normalize_tile_family)
            )
            response["from"] = int(discard["actor"])
            self.apply_self_kan_action(snapshot, response)
            return

        raise ValueError(f"Unsupported reaction action: {response}")
