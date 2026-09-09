"""User action submission and pending-review coordination."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Callable

from . import game_tree
from . import legal_actions
from . import snapshot_state
from .hora_calculation import compute_hora_result
from .rule_kernel import can_declare_riichi, can_declare_tsumo
from .service_helpers import (
    actor_just_drew,
    build_comparison_result,
    build_reaction_comparison_result,
    build_special_action_comparison_result,
    get_abortive_reason_label,
)


@dataclass
class ReviewSessionDependencies:
    get_active_reaction_window: Callable[[dict[str, Any]], dict[str, Any]]
    build_local_reaction_actions: Callable[..., list[dict[str, Any]]]
    build_legal_actions: Callable[..., list[dict[str, Any]]]
    refresh_reused_child: Callable[..., None]
    create_node: Callable[..., str]
    attach_mainline: Callable[..., None]
    promote_mainline: Callable[..., None]
    replace_pending_review_main_child: Callable[..., bool]


class ReviewSession:
    """Own the path from a user choice through review to a committed branch."""

    def __init__(
        self,
        state: dict[str, Any],
        round_actions: Any,
        round_progression: Any,
        decision_analysis: Any,
        engine_management: Any,
        game_flow: Any,
        dependencies: ReviewSessionDependencies,
    ) -> None:
        self.state = state
        self.round_actions = round_actions
        self.round_progression = round_progression
        self.decision_analysis = decision_analysis
        self.engine_management = engine_management
        self.game_flow = game_flow
        self.dependencies = dependencies

    def ensure_game_loaded(self):
        if not self.state["gameLoaded"] or not self.state["game"]:
            raise ValueError("No active game is loaded.")

    def find_user_reaction_response(self, snapshot, action_type):
        reaction_window = self.dependencies.get_active_reaction_window(snapshot)
        for item in reaction_window.get("reactions", []):
            if item.get("seat") != self.state["controlledSeat"]:
                continue

            response = item.get("response") or {}
            response_type = response.get("type")
            if action_type == "none" and response_type == "none":
                return {"seat": self.state["controlledSeat"], "response": response, "priority": 0}
            if action_type == response_type:
                if action_type == "chi":
                    continue
                return {
                    "seat": self.state["controlledSeat"],
                    "response": response,
                    "priority": self.round_actions.get_reaction_priority(response_type),
                }

        if action_type == "none":
            return {
                "seat": self.state["controlledSeat"],
                "response": {"type": "none", "actor": self.state["controlledSeat"]},
                "priority": 0,
            }
        return None

    def synthesize_user_reaction_response(self, snapshot, action_type, variant=None, candidate_id=None):
        actor = self.state["controlledSeat"]
        reaction_entries = self.dependencies.build_local_reaction_actions(snapshot, actor)
        pending_discard = snapshot.get("pendingDiscard") or {}
        pending_kan = snapshot.get("pendingKan") or {}

        if action_type == "none":
            return {
                "seat": self.state["controlledSeat"],
                "response": {
                    "type": "none",
                    "actor": actor,
                    "variant": "none",
                    "label": "Pass",
                },
                "priority": 0,
            }

        target_entry = next(
            (
                entry for entry in reaction_entries
                if (
                    (candidate_id is not None and entry.get("id") == candidate_id)
                    or (
                        candidate_id is None
                        and entry.get("type") == action_type
                        and (variant is None or entry.get("variant") == variant)
                    )
                )
            ),
            None,
        )
        if not target_entry:
            return None

        response = {
            "type": action_type,
            "actor": actor,
            "target": pending_discard.get("actor", pending_kan.get("actor")),
            "pai": target_entry.get("pai") or pending_discard.get("pai") or pending_kan.get("pai"),
            "variant": target_entry.get("variant") or action_type,
            "label": target_entry.get("label"),
            "consumed": copy.deepcopy(target_entry.get("consumed") or []),
            "meta": {
                "source": "local-legal-actions",
            },
        }
        if action_type == "pon" and not response["consumed"]:
            response["consumed"] = [response["pai"], response["pai"]]
        if action_type == "daiminkan" and not response["consumed"]:
            response["consumed"] = [response["pai"], response["pai"], response["pai"]]

        return {
            "seat": actor,
            "response": response,
            "priority": self.round_actions.get_reaction_priority(action_type),
        }

    def build_action_payload(self, action_type, *, pai=None, variant=None, source="user_review"):
        action = {
            "type": action_type,
            "actor": self.state["controlledSeat"],
            "source": source,
        }
        if pai is not None:
            action["pai"] = pai
        if variant is not None:
            action["variant"] = variant
        return action

    def create_discard_snapshot(self, parent_snapshot, tile, source="user", from_drawn=None):
        actor = parent_snapshot["currentActor"]
        next_snapshot = copy.deepcopy(parent_snapshot)

        if parent_snapshot["phase"] == "reach_declaration":
            if tile not in parent_snapshot["hands"][actor]:
                raise ValueError(f"Tile {tile} not in hand.")

            tsumogiri = bool(from_drawn)
            self.round_actions.materialize_reach_declaration_discard(
                next_snapshot,
                actor,
                tile,
                tsumogiri,
            )
            snapshot_state.persist(next_snapshot)
            next_snapshot["reactionWindow"] = (
                None
                if self.state.get("mode") == "play"
                else self.round_actions.evaluate_reactions(next_snapshot)
            )
            action = self.build_action_payload("dahai", pai=tile, source=source)
            action["riichi"] = True
            action["tsumogiri"] = bool(from_drawn)
            return next_snapshot, action

        self.round_actions.apply_discard(
            next_snapshot,
            actor,
            tile,
            from_drawn=from_drawn,
        )
        next_snapshot["reactionWindow"] = (
            None
            if self.state.get("mode") == "play"
            else self.round_actions.evaluate_reactions(next_snapshot)
        )
        action = self.build_action_payload("dahai", pai=tile, source=source)
        action["tsumogiri"] = bool(from_drawn)
        return next_snapshot, action

    def create_special_snapshot(self, parent_snapshot, action_type, variant=None, source="user"):
        actor = parent_snapshot["currentActor"]
        next_snapshot = copy.deepcopy(parent_snapshot)

        if action_type == "reach" and variant == "declare":
            if parent_snapshot["riichiAccepted"][actor]:
                raise ValueError("This seat has already accepted riichi this hand.")
            if not actor_just_drew(parent_snapshot, actor):
                raise ValueError("Riichi can only be declared immediately after drawing.")
            if parent_snapshot["scores"][actor] < 1000:
                raise ValueError("Riichi requires at least 1000 points.")
            if not can_declare_riichi(parent_snapshot, actor):
                raise ValueError("Riichi is not legal in the current position.")
            next_snapshot["pendingRiichiSeat"] = actor
            next_snapshot["riichiDeclared"][actor] = True
            next_snapshot["phase"] = "reach_declaration"
            next_snapshot["lastAction"] = {
                "type": "reach",
                "actor": actor,
                "pai": "",
            }
            next_snapshot["actionHistory"].append({
                "type": "reach",
                "actor": actor,
            })
            next_snapshot["pendingDiscard"] = None
            next_snapshot["reactionWindow"] = None
            snapshot_state.persist(next_snapshot)
            action = self.build_action_payload("reach", variant="declare", source=source)
            return next_snapshot, action

        if action_type == "ryukyoku" and variant == "kyuushu_kyuuhai":
            if not self.round_progression.can_declare_kyuushu_kyuuhai(parent_snapshot, actor):
                raise ValueError("This hand cannot declare 9 terminals abortive draw.")
            self.round_progression.mark_abortive_ryukyoku(next_snapshot, variant)
            action = {
                "type": "ryukyoku",
                "actor": self.state["controlledSeat"],
                "reason": variant,
                "reasonLabel": get_abortive_reason_label(variant),
                "source": source,
            }
            return next_snapshot, action

        if action_type == "hora":
            if not actor_just_drew(parent_snapshot, actor):
                raise ValueError("Tsumo can only be declared on a self-drawn tile.")
            if not can_declare_tsumo(parent_snapshot, actor):
                raise ValueError("Tsumo is not legal in the current position.")
            winning_tile = None
            if parent_snapshot.get("actionHistory"):
                last_action = parent_snapshot["actionHistory"][-1]
                if last_action.get("type") == "tsumo" and last_action.get("actor") == actor:
                    winning_tile = str(last_action.get("pai") or "")
            if not winning_tile:
                raise ValueError("Unable to resolve the tsumo tile for settlement.")

            self.round_progression.promote_delayed_dora_reveal(next_snapshot)
            self.round_progression.reveal_all_pending_dora(next_snapshot)
            result = compute_hora_result(next_snapshot, actor, actor, winning_tile, True)
            next_snapshot["pendingDiscard"] = None
            next_snapshot["reactionWindow"] = None
            next_snapshot["phase"] = "game_end"
            next_snapshot["currentActor"] = actor
            next_snapshot["lastAction"] = {
                "type": "hora",
                "actor": actor,
                "target": actor,
                "pai": winning_tile,
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
            next_snapshot["actionHistory"].append(
                {
                    "type": "hora",
                    "actor": actor,
                    "target": actor,
                    "pai": winning_tile,
                }
            )
            snapshot_state.persist(next_snapshot)
            action = {
                "type": "hora",
                "actor": actor,
                "target": actor,
                "pai": winning_tile,
                "variant": "tsumo",
                "source": source,
            }
            return next_snapshot, action

        if action_type in ("ankan", "kakan"):
            entry = next(
                (
                    item for item in legal_actions.get_legal_kan_actions(parent_snapshot, actor)
                    if item.get("variant") == (variant or action_type)
                ),
                None,
            )
            if not entry:
                raise ValueError(f"Kan variant is not legal in the current position: {variant or action_type}")
            response = {
                "type": entry["type"],
                "variant": entry["variant"],
                "actor": actor,
                "pai": entry.get("pai"),
                "consumed": copy.deepcopy(entry.get("consumed") or []),
                "label": entry.get("label"),
            }
            self.round_actions.apply_self_kan_action(next_snapshot, response)
            action = copy.deepcopy(response)
            action["source"] = source
            return next_snapshot, action

        raise ValueError(f"Unsupported discard-phase special action: {action_type} ({variant})")

    def create_reaction_snapshot(self, parent_snapshot, action_type, variant=None, candidate_id=None):
        selected = (
            self.synthesize_user_reaction_response(parent_snapshot, action_type, variant, candidate_id)
            if candidate_id
            else self.find_user_reaction_response(parent_snapshot, action_type)
        )
        if selected is None:
            selected = self.synthesize_user_reaction_response(parent_snapshot, action_type, variant)
        if selected is None:
            raise ValueError(f"Unsupported or unavailable reaction action: {action_type} ({variant})")
        next_snapshot = copy.deepcopy(parent_snapshot)
        self.round_actions.apply_reaction_action(next_snapshot, selected)
        action = copy.deepcopy(selected["response"])
        action["source"] = "user_reaction"
        if action.get("type") == "none":
            action["decisionOnly"] = True
        return next_snapshot, selected, action

    def _reuse_or_review_existing_child(
        self,
        game,
        parent_id,
        existing_id,
        comparison,
        *,
        action=None,
        next_snapshot=None,
        force_commit=False,
    ):
        """If reusing an existing child, check whether a review should still be triggered."""
        if action is not None and next_snapshot is not None:
            self.dependencies.refresh_reused_child(game, existing_id, action, next_snapshot)
        if comparison is not None and game["nodes"][existing_id].get("comparison") != comparison:
            game["nodes"][existing_id]["comparison"] = copy.deepcopy(comparison)
            game_tree.mark_tree_changed(game)
        if not force_commit and comparison is not None and self.should_trigger(comparison):
            self.register(game, parent_id, existing_id, comparison)
            game["currentNodeId"] = parent_id
            return False
        self.dependencies.attach_mainline(parent_id, existing_id)
        game["currentNodeId"] = existing_id
        self.dependencies.promote_mainline(game, existing_id)
        return True

    def find_existing_child(self, game, parent_id, action):
        identity = game_tree.action_identity(action)
        parent_node = game["nodes"].get(parent_id)
        if not parent_node:
            return None
        for child_id in parent_node.get("children", []):
            child = game["nodes"].get(child_id)
            if not child:
                continue
            child_action = child.get("action") or {}
            if game_tree.action_identity(child_action) == identity:
                return child_id
        return None

    def finalize(
        self,
        tile=None,
        action_type=None,
        variant=None,
        confirm_proposed=False,
        from_drawn=None,
        candidate_id=None,
    ):
        self.ensure_game_loaded()
        game = self.state["game"]
        pending_review = game.get("pendingReview")
        if not pending_review:
            raise ValueError("No pending review to finalize.")

        parent_id = pending_review["parentNodeId"]
        proposed_node_id = pending_review["proposedNodeId"]
        parent_snapshot = game["nodes"][parent_id]["snapshot"]
        parent_node = game["nodes"][parent_id]
        analysis_key = self.decision_analysis.cache_key(parent_snapshot)
        self.decision_analysis.ensure_cached(parent_node, parent_snapshot)

        if confirm_proposed:
            chosen_node_id = proposed_node_id
        else:
            if pending_review.get("phase") == "discard":
                if action_type:
                    if (variant or action_type) == pending_review["chosenKey"]:
                        chosen_node_id = proposed_node_id
                    else:
                        next_snapshot, action = self.create_special_snapshot(parent_snapshot, action_type, variant, source="user_review")
                        existing_id = self.find_existing_child(game, parent_id, action)
                        if existing_id is not None:
                            chosen_node_id = existing_id
                            self.dependencies.refresh_reused_child(game, existing_id, action, next_snapshot)
                        else:
                            chosen_node_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
                            if analysis_key in parent_node["analysisCache"]:
                                comparison = build_special_action_comparison_result(
                                    parent_node["analysisCache"][analysis_key],
                                    action_type,
                                    self.state["controlledSeat"],
                                    variant,
                                )
                                if comparison is not None:
                                    game["nodes"][chosen_node_id]["comparison"] = comparison
                elif not tile:
                    raise ValueError("A tile or action type must be provided to finalize a discard review.")
                elif tile == pending_review["chosenKey"] and bool(from_drawn) == bool(pending_review.get("chosenFromDrawn")):
                    chosen_node_id = proposed_node_id
                else:
                    next_snapshot, action = self.create_discard_snapshot(parent_snapshot, tile, from_drawn=from_drawn)
                    existing_id = self.find_existing_child(game, parent_id, action)
                    if existing_id is not None:
                        chosen_node_id = existing_id
                        self.dependencies.refresh_reused_child(game, existing_id, action, next_snapshot)
                    else:
                        chosen_node_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
                        if analysis_key in parent_node["analysisCache"]:
                            comparison = build_comparison_result(
                                parent_node["analysisCache"][analysis_key],
                                tile,
                                self.state["controlledSeat"],
                                from_drawn,
                            )
                            if comparison is not None:
                                game["nodes"][chosen_node_id]["comparison"] = comparison
            elif pending_review.get("phase") == "special":
                if tile:
                    if tile == pending_review["chosenKey"] and bool(from_drawn) == bool(pending_review.get("chosenFromDrawn")):
                        chosen_node_id = proposed_node_id
                    else:
                        next_snapshot, action = self.create_discard_snapshot(parent_snapshot, tile, from_drawn=from_drawn)
                        existing_id = self.find_existing_child(game, parent_id, action)
                        if existing_id is not None:
                            chosen_node_id = existing_id
                            self.dependencies.refresh_reused_child(game, existing_id, action, next_snapshot)
                        else:
                            chosen_node_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
                            if analysis_key in parent_node["analysisCache"]:
                                comparison = build_comparison_result(
                                    parent_node["analysisCache"][analysis_key],
                                    tile,
                                    self.state["controlledSeat"],
                                    from_drawn,
                                )
                                if comparison is not None:
                                    game["nodes"][chosen_node_id]["comparison"] = comparison
                else:
                    if not action_type:
                        raise ValueError("An action type must be provided to finalize a special review.")
                    if (variant or action_type) == pending_review["chosenKey"]:
                        chosen_node_id = proposed_node_id
                    else:
                        next_snapshot, action = self.create_special_snapshot(parent_snapshot, action_type, variant, source="user_review")
                        existing_id = self.find_existing_child(game, parent_id, action)
                        if existing_id is not None:
                            chosen_node_id = existing_id
                            self.dependencies.refresh_reused_child(game, existing_id, action, next_snapshot)
                        else:
                            chosen_node_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
                            if analysis_key in parent_node["analysisCache"]:
                                comparison = build_special_action_comparison_result(
                                    parent_node["analysisCache"][analysis_key],
                                    action_type,
                                self.state["controlledSeat"],
                                variant,
                            )
                            if comparison is not None:
                                game["nodes"][chosen_node_id]["comparison"] = comparison
            else:
                if not action_type:
                    raise ValueError("An action type must be provided to finalize a reaction review.")
                if (candidate_id or variant or action_type) == pending_review["chosenKey"]:
                    chosen_node_id = proposed_node_id
                else:
                    next_snapshot, _selected, action = self.create_reaction_snapshot(
                        parent_snapshot,
                        action_type,
                        variant,
                        candidate_id,
                    )
                    action["source"] = "user_review"
                    existing_id = self.find_existing_child(game, parent_id, action)
                    if existing_id is not None:
                        chosen_node_id = existing_id
                        self.dependencies.refresh_reused_child(game, existing_id, action, next_snapshot)
                    else:
                        chosen_node_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
                    if analysis_key in parent_node["analysisCache"]:
                        comparison = build_reaction_comparison_result(
                            parent_node["analysisCache"][analysis_key],
                            action_type,
                            self.state["controlledSeat"],
                            variant,
                            candidate_id,
                        )
                        if comparison is not None:
                            game["nodes"][chosen_node_id]["comparison"] = comparison

        game["pendingReview"] = None
        if not self.dependencies.replace_pending_review_main_child(
            game,
            parent_id,
            proposed_node_id,
            chosen_node_id,
        ):
            self.dependencies.attach_mainline(parent_id, chosen_node_id)
        game["currentNodeId"] = chosen_node_id
        self.dependencies.promote_mainline(game, chosen_node_id)
        self.advance_after_review(game, game["nodes"][chosen_node_id]["snapshot"])

    def register(self, game, parent_id, child_id, comparison, chosen_from_drawn=False):
        self.dependencies.attach_mainline(parent_id, child_id)
        game["pendingReview"] = {
            "phase": comparison["phase"],
            "parentNodeId": parent_id,
            "proposedNodeId": child_id,
            "chosenKey": comparison["chosenKey"],
            "chosenFromDrawn": bool(chosen_from_drawn),
            "bestKey": comparison["bestKey"],
            "chosenPai": comparison.get("chosenPai"),
            "bestPai": comparison.get("bestPai"),
            "chosenLabel": comparison["chosenLabel"],
            "bestLabel": comparison["bestLabel"],
            "comparison": copy.deepcopy(comparison),
        }

    def should_trigger(self, comparison):
        if not self.state.get("decisionRecommendationsEnabled", True):
            return False
        if comparison is None:
            return False
        training = self.engine_management.training_config()
        mode = training.get("mode", "threshold_review")
        if mode == "preview_before_click":
            return False
        if mode == "no_review":
            return False
        if mode == "always_review":
            return True
        if mode == "threshold_review":
            if comparison.get("isBest"):
                return False
            threshold = float(training.get("mistakeThreshold", 0.25))
            best_bar = float(comparison.get("bestBar", 0.0) or 0.0)
            chosen_bar = float(comparison.get("chosenBar", 0.0) or 0.0)
            if best_bar > 0:
                ratio = max(0.0, min(1.0, chosen_bar / best_bar))
                return ratio < threshold
            return float(comparison.get("valueGap", 0.0) or 0.0) > 0.0
        return False

    def advance_after_review(self, game, node_snapshot):
        if node_snapshot["phase"] in ("game_end", "match_end", "round_result"):
            return
        if (
            self.state.get("mode") != "play"
            and node_snapshot["phase"] not in ("reaction_window", "kan_reaction_window", "reach_declaration")
        ):
            self.game_flow.advance(game)

    def submit_reviewable_child(self, game, parent_id, child_id, comparison, force_commit=False, chosen_from_drawn=False):
        if not force_commit and self.should_trigger(comparison):
            self.register(game, parent_id, child_id, comparison, chosen_from_drawn=chosen_from_drawn)
            game["currentNodeId"] = parent_id
            return False

        self.dependencies.attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        self.dependencies.promote_mainline(game, child_id)
        return True

    def submit_special_action(self, action_type, variant=None):
        self.ensure_game_loaded()
        game = self.state["game"]
        if game.get("pendingReview"):
            self.finalize(action_type=action_type, variant=variant)
            return

        current_snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
        current_node = game["nodes"][game["currentNodeId"]]
        actor = current_snapshot["currentActor"]

        if current_snapshot["phase"] != "discard":
            raise ValueError("This action is only legal during discard selection.")
        if actor != self.state["controlledSeat"]:
            raise ValueError("Only the controlled seat can declare this action.")

        next_snapshot, action = self.create_special_snapshot(current_snapshot, action_type, variant, source="user")
        analysis_key = self.decision_analysis.cache_key(current_snapshot)
        comparison = None
        self.decision_analysis.ensure_cached(current_node, current_snapshot)
        if analysis_key in current_node["analysisCache"]:
            comparison = build_special_action_comparison_result(
                current_node["analysisCache"][analysis_key],
                action_type,
                actor,
                variant,
            )

        parent_id = game["currentNodeId"]
        existing_id = self.find_existing_child(game, parent_id, action)
        if existing_id is not None:
            self._reuse_or_review_existing_child(
                game,
                parent_id,
                existing_id,
                comparison,
                action=action,
                next_snapshot=next_snapshot,
            )
            return

        child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
        if comparison is not None:
            game["nodes"][child_id]["comparison"] = comparison
        committed = self.submit_reviewable_child(game, parent_id, child_id, comparison)
        if not committed:
            return

        if action_type in ("ankan", "kakan") and next_snapshot["phase"] == "game_end":
            self.round_progression.advance_terminal_round(game)
            return

        if action_type == "ryukyoku":
            self.round_progression.advance_terminal_round(game)

    def submit_discard(self, tile, from_drawn=None):
        self.ensure_game_loaded()
        game = self.state["game"]
        if game.get("pendingReview"):
            self.finalize(tile=tile, from_drawn=from_drawn)
            return

        current_snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
        current_node = game["nodes"][game["currentNodeId"]]
        actor = current_snapshot["currentActor"]

        if actor != self.state["controlledSeat"]:
            raise ValueError("It is not the controlled seat's turn.")
        if current_snapshot["phase"] != "discard":
            raise ValueError("The current state is not waiting for a discard.")

        next_snapshot, action = self.create_discard_snapshot(current_snapshot, tile, source="user", from_drawn=from_drawn)

        analysis_key = self.decision_analysis.cache_key(current_snapshot)
        comparison = None
        force_commit = current_snapshot.get("pendingRiichiSeat") == actor
        self.decision_analysis.ensure_cached(current_node, current_snapshot)
        if analysis_key in current_node["analysisCache"]:
            comparison = build_comparison_result(
                current_node["analysisCache"][analysis_key],
                tile,
                actor,
                from_drawn,
            )

        parent_id = game["currentNodeId"]
        existing_id = self.find_existing_child(game, parent_id, action)
        if existing_id is not None:
            self._reuse_or_review_existing_child(
                game,
                parent_id,
                existing_id,
                comparison,
                action=action,
                next_snapshot=next_snapshot,
                force_commit=force_commit,
            )
            return

        child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
        if comparison is not None:
            game["nodes"][child_id]["comparison"] = comparison
        committed = self.submit_reviewable_child(game, parent_id, child_id, comparison, force_commit=force_commit, chosen_from_drawn=from_drawn)
        if not committed:
            return

    def toggle_riichi(self):
        self.submit_special_action("reach", "declare")

    def submit_riichi_discard(self, tile, from_drawn=None):
        self.ensure_game_loaded()
        game = self.state["game"]
        if game.get("pendingReview"):
            self.finalize(tile=tile, from_drawn=from_drawn)
            return
        current_snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
        current_node = game["nodes"][game["currentNodeId"]]
        actor = current_snapshot["currentActor"]

        if actor != self.state["controlledSeat"]:
            raise ValueError("Not the controlled seat.")
        if current_snapshot["phase"] != "reach_declaration":
            raise ValueError("Not in reach declaration phase.")
        if tile not in current_snapshot["hands"][actor]:
            raise ValueError(f"Tile {tile} not in hand.")

        next_snapshot, action = self.create_discard_snapshot(current_snapshot, tile, source="user", from_drawn=from_drawn)
        analysis_key = self.decision_analysis.cache_key(current_snapshot)
        comparison = None
        self.decision_analysis.ensure_cached(current_node, current_snapshot)
        if analysis_key in current_node["analysisCache"]:
            comparison = build_comparison_result(
                current_node["analysisCache"][analysis_key],
                tile,
                actor,
                from_drawn,
            )

        parent_id = game["currentNodeId"]
        existing_id = self.find_existing_child(game, parent_id, action)
        if existing_id is not None:
            self._reuse_or_review_existing_child(
                game,
                parent_id,
                existing_id,
                comparison,
                action=action,
                next_snapshot=next_snapshot,
            )
            return

        child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
        if comparison is not None:
            game["nodes"][child_id]["comparison"] = comparison
        committed = self.submit_reviewable_child(game, parent_id, child_id, comparison, chosen_from_drawn=from_drawn)
        if not committed:
            return

    def submit_abortive_draw(self, reason):
        self.submit_special_action("ryukyoku", reason)

    def submit_self_hora(self):
        self.submit_special_action("hora", "tsumo")

    def submit_self_kan(self, variant):
        action_type = str(variant or "").split(":", 1)[0] or "ankan"
        self.submit_special_action(action_type, variant)

    def submit_riichi_ankan_skip(self):
        self.ensure_game_loaded()
        game = self.state["game"]
        parent_id = game["currentNodeId"]
        parent_node = game["nodes"][parent_id]
        parent_snapshot = parent_node["snapshot"]
        actor = int(parent_snapshot.get("currentActor", -1))
        if (
            parent_snapshot.get("phase") != "discard"
            or parent_snapshot.get("riichiDiscardState") != "ankan_choice"
            or actor != self.state["controlledSeat"]
        ):
            raise ValueError("Skip is only legal during the controlled riichi ankan choice.")
        action = next(
            (
                copy.deepcopy(candidate)
                for candidate in self.dependencies.build_legal_actions(parent_snapshot, controlled_seat=actor)
                if candidate.get("type") == "none"
            ),
            None,
        )
        if action is None:
            raise ValueError("The current position has no riichi ankan skip action.")
        action.pop("id", None)
        action["decisionOnly"] = True
        action["source"] = "user"
        next_snapshot = copy.deepcopy(parent_snapshot)
        next_snapshot["riichiDiscardState"] = None
        snapshot_state.persist(next_snapshot)
        child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)

        analysis_key = self.decision_analysis.cache_key(parent_snapshot)
        self.decision_analysis.ensure_cached(parent_node, parent_snapshot)
        if analysis_key in parent_node["analysisCache"]:
            comparison = build_special_action_comparison_result(
                parent_node["analysisCache"][analysis_key],
                "none",
                actor,
                action.get("variant"),
            )
            if comparison is not None:
                game["nodes"][child_id]["comparison"] = comparison
        self.dependencies.attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        self.dependencies.promote_mainline(game, child_id)
        self.game_flow.process_riichi_auto_tsumogiri(game, next_snapshot, actor)

    def submit_reaction(self, action_type, variant=None, candidate_id=None):
        self.ensure_game_loaded()
        game = self.state["game"]
        current_snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
        current_node = game["nodes"][game["currentNodeId"]]

        if current_snapshot["phase"] not in ("reaction_window", "kan_reaction_window"):
            raise ValueError("The current state is not waiting for a reaction.")

        if game.get("pendingReview"):
            self.finalize(
                action_type=action_type,
                variant=variant,
                candidate_id=candidate_id,
            )
            return

        next_snapshot, _selected, action = self.create_reaction_snapshot(
            current_snapshot,
            action_type,
            variant,
            candidate_id,
        )
        analysis_key = self.decision_analysis.cache_key(current_snapshot)
        comparison = None
        self.decision_analysis.ensure_cached(current_node, current_snapshot)
        if analysis_key in current_node["analysisCache"]:
            comparison = build_reaction_comparison_result(
                current_node["analysisCache"][analysis_key],
                action_type,
                self.state["controlledSeat"],
                variant,
                candidate_id,
            )

        parent_id = game["currentNodeId"]
        existing_id = self.find_existing_child(game, parent_id, action)
        if existing_id is not None:
            self._reuse_or_review_existing_child(
                game,
                parent_id,
                existing_id,
                comparison,
                action=action,
                next_snapshot=next_snapshot,
            )
            return

        child_id = self.dependencies.create_node(game, parent_id, action, next_snapshot)
        if comparison is not None:
            game["nodes"][child_id]["comparison"] = comparison
        committed = self.submit_reviewable_child(game, parent_id, child_id, comparison)
        if not committed:
            return

        self.advance_after_review(game, next_snapshot)
