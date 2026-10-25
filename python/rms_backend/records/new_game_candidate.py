"""Advance a private initial game without temporarily replacing live state."""

from dataclasses import replace

from ..game_flow import GameFlow
from ..reaction_decision_history import ReactionDecisionHistory
from ..round_actions import RoundActions
from ..round_progression import RoundProgression


def advance_new_game(game, seat, *, tree, flow, reactions, choose_ai):
    candidate_tree = tree.for_private_game(game)
    progression = RoundProgression(replace(flow.round_progression.dependencies,
        create_node=candidate_tree.create_node, attach_mainline=candidate_tree.attach_mainline,
        promote_mainline=candidate_tree.promote_path_to_mainline))
    actions = RoundActions(progression, replace(flow.round_actions.dependencies,
        controlled_seat=lambda: seat, choose_ai_action=choose_ai))
    history = ReactionDecisionHistory(replace(reactions.dependencies,
        create_node=candidate_tree.create_node, attach_mainline=candidate_tree.attach_mainline,
        promote_mainline=candidate_tree.promote_path_to_mainline))
    candidate_flow = GameFlow(actions, progression, replace(flow.dependencies,
        controlled_seat=lambda: seat, choose_ai_action=choose_ai,
        controlled_seat_has_pending_action=lambda snapshot: bool(
            flow.dependencies.build_legal_actions(snapshot, controlled_seat=seat)),
        apply_pending_seat_switch=lambda snapshot: False,
        materialize_automatic_reaction_decisions=history.materialize_automatic,
        create_node=candidate_tree.create_node, attach_mainline=candidate_tree.attach_mainline,
        promote_mainline=candidate_tree.promote_path_to_mainline))
    candidate_flow.advance(game)
