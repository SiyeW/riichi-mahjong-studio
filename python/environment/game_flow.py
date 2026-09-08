"""High-level coordination of draws, discards, reactions and round transitions."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Callable

import snapshot_state
from hora_calculation import compute_hora_result
from rule_kernel import can_ankan, can_declare_riichi, can_declare_tsumo
from service_helpers import actor_just_drew


@dataclass
class GameFlowDependencies:
    controlled_seat: Callable[[], int]
    action_weight_path: Callable[[], str]
    choose_ai_action: Callable[..., dict[str, Any]]
    build_legal_actions: Callable[..., list[dict[str, Any]]]
    controlled_seat_has_pending_action: Callable[[dict[str, Any]], bool]
    apply_pending_seat_switch: Callable[[dict[str, Any]], bool]
    materialize_automatic_reaction_decisions: Callable[..., dict[str, Any]]
    create_node: Callable[..., str]
    attach_mainline: Callable[..., None]
    promote_mainline: Callable[..., None]
    debug: Callable[[str], None]


class GameFlow:
    """Advance the live game tree one observable action at a time."""

    def __init__(
        self,
        round_actions: Any,
        round_progression: Any,
        dependencies: GameFlowDependencies,
    ) -> None:
        self.round_actions = round_actions
        self.round_progression = round_progression
        self.dependencies = dependencies

    def choose_ai_discard(self, snapshot, actor):
        snapshot_state.sync(snapshot)
        model_path = self.dependencies.action_weight_path()
        can_use_drawn_tile_options = actor_just_drew(snapshot, actor)
        response = self.dependencies.choose_ai_action(snapshot, actor, model_path)
        requested_tsumogiri = response.get("tsumogiri") if isinstance(response.get("tsumogiri"), bool) else None
        used_fallback = False
        self.dependencies.debug(f"[FLOW] choose_ai_discard actor={actor} can_use_drawn={can_use_drawn_tile_options} response_type={response.get('type')} pai={response.get('pai')}")
        if (
            can_use_drawn_tile_options
            and response.get("type") == "reach"
            and can_declare_riichi(snapshot, actor)
        ):
            return {"type": "reach", "actor": actor}

        if can_use_drawn_tile_options and response.get("type") in ("ankan", "kakan"):
            self.dependencies.debug("[FLOW] choose_ai_discard returning kan action")
            return copy.deepcopy(response)

        if response.get("type") in ("none", "pon", "chi", "daiminkan", "reach", "ankan", "kakan"):
            self.dependencies.debug(f"[FLOW] choose_ai_discard FALLBACK from type={response.get('type')}")
            fallback_tile = None
            if snapshot.get("actionHistory"):
                last_action = snapshot["actionHistory"][-1]
                if last_action.get("type") == "tsumo" and last_action.get("actor") == actor:
                    candidate = str(last_action.get("pai") or "")
                    if candidate in snapshot["hands"][actor]:
                        fallback_tile = candidate
            if fallback_tile is None and snapshot["hands"][actor]:
                fallback_tile = snapshot["hands"][actor][-1]
            if fallback_tile is None:
                raise ValueError(f"AI actor {actor} had no fallback discard after invalid discard-phase response: {response}")
            response = {
                "type": "dahai",
                "actor": actor,
                "pai": fallback_tile,
                "meta": {
                    "fallback": True,
                    "original": copy.deepcopy(response),
                },
            }
            used_fallback = True

        if can_use_drawn_tile_options and response.get("type") == "hora":
            winning_tile = None
            if snapshot.get("actionHistory"):
                last_action = snapshot["actionHistory"][-1]
                if last_action.get("type") == "tsumo" and last_action.get("actor") == actor:
                    winning_tile = str(last_action.get("pai") or "")
            if winning_tile and can_declare_tsumo(snapshot, actor):
                try:
                    compute_hora_result(copy.deepcopy(snapshot), actor, actor, winning_tile, True)
                    return {
                        "type": "hora",
                        "actor": actor,
                        "pai": winning_tile,
                    }
                except Exception:  # pylint: disable=broad-except
                    pass
            response = {
                "type": "none",
                "actor": actor,
                "variant": "none",
                "label": "Pass",
                "meta": {
                    "skip_reason": "invalid_self_hora",
                },
            }

        if response.get("type") != "dahai":
            fallback_tile = None
            if snapshot.get("actionHistory"):
                last_action = snapshot["actionHistory"][-1]
                if last_action.get("type") == "tsumo" and last_action.get("actor") == actor:
                    candidate = str(last_action.get("pai") or "")
                    if candidate in snapshot["hands"][actor]:
                        fallback_tile = candidate
            if fallback_tile is None and snapshot["hands"][actor]:
                fallback_tile = snapshot["hands"][actor][-1]
            if fallback_tile is None:
                raise ValueError(f"Unsupported AI response for current discard flow: {response}")
            response = {
                "type": "dahai",
                "actor": actor,
                "pai": fallback_tile,
                "meta": {
                    "fallback": True,
                    "original": copy.deepcopy(response),
                },
            }
            used_fallback = True
        tile = response.get("pai")
        if tile not in snapshot["hands"][actor]:
            normalized = str(tile).replace("5m", "5mr").replace("5p", "5pr").replace("5s", "5sr")
            if normalized in snapshot["hands"][actor]:
                tile = normalized
        if tile not in snapshot["hands"][actor]:
            fallback_tile = None
            if snapshot.get("actionHistory"):
                last_action = snapshot["actionHistory"][-1]
                if last_action.get("type") == "tsumo" and last_action.get("actor") == actor:
                    candidate = str(last_action.get("pai") or "")
                    if candidate in snapshot["hands"][actor]:
                        fallback_tile = candidate
            if fallback_tile is None and snapshot["hands"][actor]:
                fallback_tile = snapshot["hands"][actor][-1]
            if fallback_tile is None:
                raise ValueError(f"AI selected tile {tile} not present in hand for actor {actor}.")
            tile = fallback_tile
            used_fallback = True
        return {
            "type": "dahai",
            "actor": actor,
            "pai": tile,
            "tsumogiri": self.round_actions.resolve_discard_tsumogiri(
                snapshot,
                actor,
                tile,
                None if used_fallback else requested_tsumogiri,
            ),
        }

    def create_tsumo_node(self, game, parent_snapshot, actor, source="wall"):
        """Create a TSUMO child node: draw a tile for the actor, transitioning to discard phase."""
        next_snapshot = copy.deepcopy(parent_snapshot)
        drawn_tile = self.round_actions.draw_tile(next_snapshot, actor, source=source)
        next_snapshot["pendingRinshanDraw"] = False
        next_snapshot["phase"] = "discard"
        snapshot_state.persist(next_snapshot)
        action = {
            "type": "tsumo",
            "actor": actor,
            "pai": drawn_tile,
        }
        if source != "wall":
            action["source"] = source
        parent_id = game["currentNodeId"]
        child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
        self.dependencies.attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        self.dependencies.promote_mainline(game, child_id)

    def advance_reaction_window(self, game, snapshot):
        """Resolve reaction window by creating child nodes for the resolved action.

        The parent (DAHAI) node's snapshot is NOT mutated. Child nodes capture
        the post-reaction state.

        Riichi acceptance (reach_accepted) is handled while applying the reaction.
        Rule timing: before the next draw (none) or before the meld.
        (pon/chi/daiminkan). Hora (ron) does NOT accept riichi.
        """
        self.dependencies.apply_pending_seat_switch(snapshot)
        reaction_window = snapshot.get("reactionWindow")
        if not isinstance(reaction_window, dict) or not isinstance(
            reaction_window.get("selected"), dict
        ):
            snapshot["reactionWindow"] = self.round_actions.evaluate_reactions(snapshot)
        if self.dependencies.controlled_seat_has_pending_action(snapshot):
            return

        selected = snapshot["reactionWindow"]["selected"]
        resolution_snapshot = self.dependencies.materialize_automatic_reaction_decisions(game, snapshot, selected)
        next_snapshot = copy.deepcopy(resolution_snapshot)
        selected = next_snapshot["reactionWindow"]["selected"]
        response = selected["response"]
        action_type = response.get("type", "none")

        # Applying the reaction already resolves any pending riichi acceptance.
        self.round_actions.apply_reaction_action(next_snapshot, selected)

        if next_snapshot["phase"] == "game_end":
            last = next_snapshot.get("lastAction") or {}
            if last.get("type") == "ryukyoku":
                action = {
                    "type": "ryukyoku",
                    "actor": last.get("actor", selected["seat"]),
                    "reason": last.get("reason"),
                    "reasonLabel": last.get("reasonLabel"),
                }
            else:
                # Hora (ron) – riichi is NOT accepted when the declaration tile is
                # ron'd, so no reach_accepted node is created and no bet is collected.
                action = {
                    "type": "hora",
                    "actor": last.get("actor", selected["seat"]),
                    "target": last.get("target"),
                    "pai": last.get("pai"),
                }
            parent_id = game["currentNodeId"]
            child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
            self.dependencies.attach_mainline(parent_id, child_id)
            game["currentNodeId"] = child_id
            self.dependencies.promote_mainline(game, child_id)
            return

        if action_type == "none":
            actor = next_snapshot["currentActor"]
            if len(next_snapshot["hands"][actor]) % 3 != 2:
                if not self.round_progression.has_wall_draw_available(next_snapshot):
                    self.round_progression.mark_exhaustive_ryukyoku(next_snapshot)
                    last = next_snapshot.get("lastAction") or {}
                    action = {
                        "type": "ryukyoku",
                        "actor": next_snapshot.get("dealer", 0),
                        "reason": last.get("reason"),
                        "reasonLabel": last.get("reasonLabel"),
                    }
                    parent_id = game["currentNodeId"]
                    child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
                    self.dependencies.attach_mainline(parent_id, child_id)
                    game["currentNodeId"] = child_id
                    self.dependencies.promote_mainline(game, child_id)
                    self.round_progression.advance_terminal_round(game)
                    return
                self.round_actions.draw_one(next_snapshot, actor)
            action = {
                "type": "tsumo",
                "actor": actor,
                "pai": next_snapshot["hands"][actor][-1] if next_snapshot["hands"][actor] else "",
            }
        else:
            # pon, chi, daiminkan
            action = copy.deepcopy(response)
            parent_id = game["currentNodeId"]
            child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
            self.dependencies.attach_mainline(parent_id, child_id)
            game["currentNodeId"] = child_id
            self.dependencies.promote_mainline(game, child_id)
            return

        parent_id = game["currentNodeId"]
        child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
        self.dependencies.attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        self.dependencies.promote_mainline(game, child_id)

    def advance_kan_reaction_window(self, game, snapshot):
        """Resolve kan reaction window by creating a child node."""
        self.dependencies.apply_pending_seat_switch(snapshot)
        reaction_window = snapshot.get("kanReactionWindow")
        if not isinstance(reaction_window, dict) or not isinstance(
            reaction_window.get("selected"), dict
        ):
            snapshot["kanReactionWindow"] = self.round_actions.build_kan_reaction_window(
                snapshot
            )
        if self.dependencies.controlled_seat_has_pending_action(snapshot):
            return

        selected = snapshot["kanReactionWindow"]["selected"]
        resolution_snapshot = self.dependencies.materialize_automatic_reaction_decisions(game, snapshot, selected)
        next_snapshot = copy.deepcopy(resolution_snapshot)
        selected = next_snapshot["kanReactionWindow"]["selected"]
        response = selected["response"]
        action_type = response.get("type", "none")

        self.round_actions.apply_reaction_action(next_snapshot, selected)

        if next_snapshot["phase"] == "game_end":
            last = next_snapshot.get("lastAction") or {}
            if last.get("type") == "ryukyoku":
                action = {
                    "type": "ryukyoku",
                    "actor": last.get("actor", selected["seat"]),
                    "reason": last.get("reason"),
                    "reasonLabel": last.get("reasonLabel"),
                }
            else:
                action = {
                    "type": "hora",
                    "actor": last.get("actor", selected["seat"]),
                    "target": last.get("target"),
                    "pai": last.get("pai"),
                }
            parent_id = game["currentNodeId"]
            child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
            self.dependencies.attach_mainline(parent_id, child_id)
            game["currentNodeId"] = child_id
            self.dependencies.promote_mainline(game, child_id)
            return

        if action_type == "none":
            actor = next_snapshot["currentActor"]
            self.round_actions.draw_tile(next_snapshot, actor, source="rinshan")
            next_snapshot["pendingRinshanDraw"] = False
            next_snapshot["phase"] = "discard"
            snapshot_state.persist(next_snapshot)
            action = {
                "type": "tsumo",
                "actor": actor,
                "pai": next_snapshot["hands"][actor][-1],
                "source": "rinshan",
            }
        else:
            action = copy.deepcopy(response)

        parent_id = game["currentNodeId"]
        child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
        self.dependencies.attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        self.dependencies.promote_mainline(game, child_id)

    def process_ai_discard(self, game, snapshot, actor):
        """Compute AI discard action and create the appropriate child node."""
        self.dependencies.debug(f"[FLOW] _process_ai_discard actor={actor} phase={snapshot.get('phase')} hand_len={len(snapshot['hands'][actor])}")
        ai_action = self.choose_ai_discard(snapshot, actor)
        self.dependencies.debug(f"[FLOW] _process_ai_discard ai_action type={ai_action.get('type')} pai={ai_action.get('pai')} riichi={ai_action.get('riichi')}")

        if ai_action["type"] == "hora":
            next_snapshot = copy.deepcopy(snapshot)
            if ai_action.get("riichi"):
                next_snapshot["pendingRiichiSeat"] = actor
                if "kyokuState" in next_snapshot:
                    next_snapshot["kyokuState"]["pendingRiichiSeat"] = actor
                next_snapshot["riichiDeclared"][actor] = True
                next_snapshot["actionHistory"].append({"type": "reach", "actor": actor})
                self.round_progression.accept_riichi_for_seat(
                    next_snapshot,
                    actor,
                    clear_pending=True,
                )
            self.round_progression.promote_delayed_dora_reveal(next_snapshot)
            self.round_progression.reveal_all_pending_dora(next_snapshot)
            result = compute_hora_result(next_snapshot, actor, actor, str(ai_action.get("pai") or ""), True)
            next_snapshot["pendingDiscard"] = None
            next_snapshot["reactionWindow"] = None
            next_snapshot["phase"] = "game_end"
            next_snapshot["currentActor"] = actor
            next_snapshot["lastAction"] = {
                "type": "hora",
                "actor": actor,
                "target": actor,
                "pai": str(ai_action.get("pai") or ""),
                "isTsumo": True,
                "deltas": copy.deepcopy(result["deltas"]),
                "uraMarkers": copy.deepcopy(result["uraMarkers"]),
                "han": result.get("han"),
                "fu": result.get("fu"),
                "yaku": copy.deepcopy(result.get("yaku", [])),
                "yakuDetails": copy.deepcopy(result.get("yakuDetails", [])),
                "isOpenHand": result.get("isOpenHand"),
                "cost": copy.deepcopy(result.get("cost", {})),
            }
            next_snapshot["actionHistory"].append({
                "type": "hora",
                "actor": actor,
                "target": actor,
                "pai": str(ai_action.get("pai") or ""),
            })
            snapshot_state.persist(next_snapshot)
            action = {
                "type": "hora",
                "actor": actor,
                "target": actor,
                "pai": str(ai_action.get("pai") or ""),
                "variant": "tsumo",
                "source": "ai",
            }
            if ai_action.get("riichi"):
                action["riichi"] = True
            parent_id = game["currentNodeId"]
            child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
            self.dependencies.attach_mainline(parent_id, child_id)
            game["currentNodeId"] = child_id
            self.dependencies.promote_mainline(game, child_id)
            return

        if ai_action["type"] in ("ankan", "kakan"):
            next_snapshot = copy.deepcopy(snapshot)
            self.round_actions.apply_self_kan_action(next_snapshot, ai_action)
            action = copy.deepcopy(ai_action)
            action["source"] = "ai"
            parent_id = game["currentNodeId"]
            child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
            self.dependencies.attach_mainline(parent_id, child_id)
            game["currentNodeId"] = child_id
            self.dependencies.promote_mainline(game, child_id)
            if next_snapshot["phase"] != "game_end":
                return
            self.round_progression.advance_terminal_round(game)
            return

        if ai_action["type"] == "reach":
            next_snapshot = copy.deepcopy(snapshot)
            snapshot_state.sync(next_snapshot)
            next_snapshot["pendingRiichiSeat"] = actor
            if "kyokuState" in next_snapshot:
                next_snapshot["kyokuState"]["pendingRiichiSeat"] = actor
            next_snapshot["riichiDeclared"][actor] = True
            next_snapshot["actionHistory"].append({"type": "reach", "actor": actor})
            next_snapshot["lastAction"] = {"type": "reach", "actor": actor}
            next_snapshot["phase"] = "reach_declaration"
            next_snapshot["pendingDiscard"] = None
            next_snapshot["reactionWindow"] = None
            snapshot_state.persist(next_snapshot)
            action = {
                "type": "reach",
                "variant": "declare",
                "actor": actor,
                "source": "ai",
            }
            parent_id = game["currentNodeId"]
            child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
            self.dependencies.attach_mainline(parent_id, child_id)
            game["currentNodeId"] = child_id
            self.dependencies.promote_mainline(game, child_id)
            return

        if snapshot.get("riichiDiscardState") == "ankan_choice":
            skip_action = next(
                (
                    copy.deepcopy(candidate)
                    for candidate in self.dependencies.build_legal_actions(snapshot, controlled_seat=actor)
                    if candidate.get("type") == "none"
                ),
                None,
            )
            if skip_action is not None:
                skip_action.pop("id", None)
                skip_action["decisionOnly"] = True
                skip_action["source"] = "ai"
                skip_snapshot = copy.deepcopy(snapshot)
                skip_snapshot["riichiDiscardState"] = None
                snapshot_state.persist(skip_snapshot)
                parent_id = game["currentNodeId"]
                skip_id = self.dependencies.create_node(game, parent_id, skip_action, skip_snapshot)
                self.dependencies.attach_mainline(parent_id, skip_id)
                game["currentNodeId"] = skip_id
                self.dependencies.promote_mainline(game, skip_id)
                snapshot = skip_snapshot

        discard_tile = ai_action["pai"]
        tsumogiri = bool(ai_action.get("tsumogiri"))
        next_snapshot = copy.deepcopy(snapshot)
        self.round_actions.apply_discard(
            next_snapshot,
            actor,
            discard_tile,
            from_drawn=tsumogiri,
        )
        next_snapshot["reactionWindow"] = None
        action = {
            "type": "dahai",
            "actor": actor,
            "pai": discard_tile,
            "tsumogiri": tsumogiri,
            "source": "ai",
        }
        parent_id = game["currentNodeId"]
        child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
        self.dependencies.attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        self.dependencies.promote_mainline(game, child_id)

    def process_riichi_auto_tsumogiri(self, game, snapshot, actor):
        """Auto-discard the drawn tile as tsumogiri for a riichi'd player."""
        hand = list(snapshot.get("hands", [])[actor])
        action_history = snapshot.get("actionHistory") or []
        last_action = action_history[-1] if action_history else {}
        drawn_tile = last_action.get("pai", "") if last_action.get("type") == "tsumo" and last_action.get("actor") == actor else ""
        if not drawn_tile and hand:
            drawn_tile = hand[-1]
        if not drawn_tile:
            raise ValueError("Cannot determine drawn tile for riichi auto-tsumogiri.")

        next_snapshot = copy.deepcopy(snapshot)
        next_snapshot["riichiDiscardState"] = None
        self.round_actions.apply_discard(next_snapshot, actor, drawn_tile)
        next_snapshot["reactionWindow"] = None

        action = {
            "type": "dahai",
            "actor": actor,
            "pai": drawn_tile,
            "tsumogiri": True,
            "source": "riichi_auto",
        }

        parent_id = game["currentNodeId"]
        child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
        self.dependencies.attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        self.dependencies.promote_mainline(game, child_id)

    def advance(self, game):
        """Process exactly one mjai action per call, creating a tree node for each frame."""
        current_snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]

        if current_snapshot["phase"] == "match_end":
            return

        if current_snapshot["phase"] == "game_end":
            self.round_progression.advance_terminal_round(game)
            return

        if current_snapshot["phase"] == "round_result":
            match_state = game.get("matchState") or {}
            last_result = (current_snapshot.get("lastAction") or {}).get("result") or {}
            round_result_stub = {
                "canRenchan": bool(last_result.get("canRenchan", False)),
                "hasHora": bool(last_result.get("hasHora", False)),
                "hasAbortiveRyukyoku": bool(last_result.get("hasAbortiveRyukyoku", False)),
                "eventType": last_result.get("eventType"),
                "eventData": copy.deepcopy(last_result.get("eventData") or {}),
                "scores": copy.deepcopy(last_result.get(
                    "scores",
                    current_snapshot.get("scores", [25000, 25000, 25000, 25000]),
                )),
                "kyotakuLeft": int(last_result.get("kyotakuLeft", current_snapshot.get("kyotaku", 0))),
            }
            if match_state.get("ended"):
                game["currentNodeId"] = self.round_progression.ensure_match_end_node(
                    game,
                    game["currentNodeId"],
                    current_snapshot,
                    round_result_stub,
                    match_state,
                )
            else:
                next_kyoku_snapshot = self.round_progression.create_next_kyoku_snapshot(
                    current_snapshot,
                    match_state,
                )
                self.round_progression.commit_system_transition(
                    game,
                    game["currentNodeId"],
                    {
                        "type": "start_kyoku",
                        "source": "system",
                        "bakaze": match_state.get("bakaze", "E"),
                        "kyoku": match_state.get("kyoku", 1),
                    },
                    next_kyoku_snapshot,
                )
            return

        if current_snapshot["phase"] == "reach_declaration":
            if current_snapshot["currentActor"] == self.dependencies.controlled_seat():
                return
            actor = current_snapshot["currentActor"]
            model_path = self.dependencies.action_weight_path()
            response = self.dependencies.choose_ai_action(current_snapshot, actor, model_path)
            self.dependencies.debug(f"[FLOW] advance reach_declaration AI actor={actor} response_type={response.get('type')} pai={response.get('pai')}")

            tile = response.get("pai") if response.get("type") == "dahai" else None
            used_fallback = response.get("type") != "dahai"
            requested_tsumogiri = response.get("tsumogiri") if isinstance(response.get("tsumogiri"), bool) else None
            if not tile or tile not in current_snapshot["hands"][actor]:
                normalized = str(tile or "").replace("5m", "5mr").replace("5p", "5pr").replace("5s", "5sr")
                if normalized in current_snapshot["hands"][actor]:
                    tile = normalized
            if not tile or tile not in current_snapshot["hands"][actor]:
                if current_snapshot.get("actionHistory"):
                    last_action = current_snapshot["actionHistory"][-1]
                    if last_action.get("type") == "tsumo" and last_action.get("actor") == actor:
                        candidate = str(last_action.get("pai") or "")
                        if candidate in current_snapshot["hands"][actor]:
                            tile = candidate
                            used_fallback = True
            if not tile or tile not in current_snapshot["hands"][actor]:
                tile = current_snapshot["hands"][actor][-1] if current_snapshot["hands"][actor] else None
                used_fallback = True
            if not tile:
                raise ValueError(f"AI reach_declaration: no valid discard tile for actor {actor}")

            tsumogiri = self.round_actions.resolve_discard_tsumogiri(
                current_snapshot,
                actor,
                tile,
                None if used_fallback else requested_tsumogiri,
            )

            next_snapshot = copy.deepcopy(current_snapshot)
            snapshot_state.sync(next_snapshot)
            self.round_actions.materialize_reach_declaration_discard(
                next_snapshot,
                actor,
                tile,
                tsumogiri,
            )
            snapshot_state.persist(next_snapshot)
            next_snapshot["reactionWindow"] = None
            action = {
                "type": "dahai",
                "actor": actor,
                "pai": tile,
                "tsumogiri": tsumogiri,
                "riichi": True,
                "source": "ai",
            }
            parent_id = game["currentNodeId"]
            child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
            self.dependencies.attach_mainline(parent_id, child_id)
            game["currentNodeId"] = child_id
            self.dependencies.promote_mainline(game, child_id)
            return

        if self.round_progression.has_immediate_dora_reveal(current_snapshot):
            next_snapshot = copy.deepcopy(current_snapshot)
            self.round_progression.consume_immediate_dora_reveal(next_snapshot)
            self.round_progression.reveal_next_dora(next_snapshot)
            self.round_progression.maybe_mark_abortive_ryukyoku(next_snapshot)
            snapshot_state.persist(next_snapshot)
            action = copy.deepcopy(next_snapshot.get("lastAction") or {"type": "dora", "actor": current_snapshot.get("currentActor", 0)})
            parent_id = game["currentNodeId"]
            child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
            self.dependencies.attach_mainline(parent_id, child_id)
            game["currentNodeId"] = child_id
            self.dependencies.promote_mainline(game, child_id)
            return

        if current_snapshot.get("pendingRinshanDraw") and current_snapshot["phase"] == "draw_or_discard":
            actor = current_snapshot["currentActor"]
            self.create_tsumo_node(game, current_snapshot, actor, source="rinshan")
            return

        if current_snapshot["phase"] == "reaction_window":
            self.advance_reaction_window(game, current_snapshot)
            return

        if current_snapshot["phase"] == "kan_reaction_window":
            self.advance_kan_reaction_window(game, current_snapshot)
            return

        self.dependencies.apply_pending_seat_switch(current_snapshot)
        actor = current_snapshot["currentActor"]

        if current_snapshot["phase"] == "draw_or_discard":
            if len(current_snapshot["hands"][actor]) % 3 == 2:
                current_snapshot["phase"] = "discard"
            else:
                if not self.round_progression.has_wall_draw_available(current_snapshot):
                    self.round_progression.mark_exhaustive_ryukyoku(current_snapshot)
                    self.round_progression.advance_terminal_round(game)
                    return
                self.create_tsumo_node(game, current_snapshot, actor)
                return

        if actor == self.dependencies.controlled_seat() and current_snapshot["phase"] == "discard":
            if current_snapshot.get("riichiAccepted", [False, False, False, False])[actor]:
                if actor_just_drew(current_snapshot, actor) and can_declare_tsumo(current_snapshot, actor):
                    self.dependencies.debug(f"[FLOW] advance_game_flow WAIT_USER riichi tsumo available actor={actor}")
                    return

                riichi_state = current_snapshot.get("riichiDiscardState")
                if riichi_state == "ankan_choice":
                    current_snapshot["riichiDiscardState"] = None
                    self.process_riichi_auto_tsumogiri(game, current_snapshot, actor)
                    return
                if riichi_state != "pending_pause":
                    current_snapshot["riichiDiscardState"] = "pending_pause"
                    return
                if can_ankan(current_snapshot, actor):
                    current_snapshot["riichiDiscardState"] = "ankan_choice"
                    return
                current_snapshot["riichiDiscardState"] = None
                self.process_riichi_auto_tsumogiri(game, current_snapshot, actor)
                return

            self.dependencies.debug(f"[FLOW] advance_game_flow WAIT_USER phase={current_snapshot['phase']} actor={actor}")
            return

        if current_snapshot["phase"] != "discard":
            return

        if current_snapshot.get("riichiAccepted", [False, False, False, False])[actor]:
            if actor_just_drew(current_snapshot, actor) and can_declare_tsumo(current_snapshot, actor):
                pass  # fall through to the decision engine — AI needs to decide tsumo
            elif can_ankan(current_snapshot, actor):
                pass  # fall through to the decision engine — AI needs to decide ankan
            else:
                self.process_riichi_auto_tsumogiri(game, current_snapshot, actor)
                return

        self.dependencies.debug(f"[FLOW] advance_game_flow -> _process_ai_discard phase={current_snapshot['phase']} actor={actor}")
        self.process_ai_discard(game, current_snapshot, actor)
