"""Materialize and repair reaction decisions in the persisted game tree."""

from __future__ import annotations

import copy
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from . import game_tree


Game = dict[str, Any]
Snapshot = dict[str, Any]


def get_active_reaction_window(snapshot: Snapshot) -> dict[str, Any]:
    if snapshot.get("phase") == "reaction_window":
        return snapshot.get("reactionWindow") or {}
    if snapshot.get("phase") == "kan_reaction_window":
        return snapshot.get("kanReactionWindow") or {}
    return {}


def _reaction_window_field(snapshot: Snapshot) -> str | None:
    if snapshot.get("phase") == "reaction_window":
        return "reactionWindow"
    if snapshot.get("phase") == "kan_reaction_window":
        return "kanReactionWindow"
    return None


def _decision_snapshot(snapshot: Snapshot, seat: int) -> Snapshot:
    next_snapshot = copy.deepcopy(snapshot)
    window_field = _reaction_window_field(next_snapshot)
    if window_field is None:
        return next_snapshot
    reaction_window = next_snapshot.get(window_field)
    if not isinstance(reaction_window, dict):
        return next_snapshot
    resolved_seats = [
        int(value)
        for value in reaction_window.get("resolvedSeats", [])
        if isinstance(value, int) or str(value).isdigit()
    ]
    if seat not in resolved_seats:
        resolved_seats.append(seat)
    reaction_window["resolvedSeats"] = resolved_seats
    return next_snapshot


def _decision_action(
    response: dict[str, Any] | None,
    seat: int,
    source: str,
) -> dict[str, Any]:
    action = copy.deepcopy(response) if isinstance(response, dict) else {}
    action["actor"] = seat
    action_type = str(action.get("type") or "none")
    action["type"] = action_type
    if action_type == "none":
        action.setdefault("variant", "none")
        action.setdefault("label", "Pass")
    action["decisionOnly"] = True
    action["source"] = source
    return action


@dataclass(frozen=True)
class ReactionDecisionDependencies:
    normalize_seat: Callable[[Any], int]
    build_legal_actions: Callable[..., list[dict[str, Any]]]
    create_node: Callable[..., str]
    attach_mainline: Callable[..., None]
    promote_mainline: Callable[..., None]


class ReactionDecisionHistory:
    """Own decision-node insertion for live reactions and imported records."""

    def __init__(self, dependencies: ReactionDecisionDependencies) -> None:
        self.dependencies = dependencies

    def materialize_automatic(
        self,
        game: Game,
        snapshot: Snapshot,
        selected: dict[str, Any] | None,
    ) -> Snapshot:
        window_field = _reaction_window_field(snapshot)
        reaction_window = snapshot.get(window_field) if window_field else None
        if not isinstance(reaction_window, dict):
            return snapshot
        selected = selected if isinstance(selected, dict) else {}
        selected_seat = selected.get("seat")
        selected_response = (
            selected.get("response")
            if isinstance(selected.get("response"), dict)
            else {}
        )
        selected_type = str(selected_response.get("type") or "none")

        for item in reaction_window.get("reactions", []):
            if not isinstance(item, dict):
                continue
            try:
                seat = self.dependencies.normalize_seat(item.get("seat"))
            except (TypeError, ValueError):
                continue
            response = (
                item.get("response")
                if isinstance(item.get("response"), dict)
                else {}
            )
            if selected_type != "none" and seat == selected_seat:
                continue
            self._append_live_node(game, response, seat)

        return game["nodes"][game["currentNodeId"]]["snapshot"]

    def repair(self, game: Game) -> int:
        nodes = game.get("nodes") if isinstance(game, dict) else None
        if not isinstance(nodes, dict):
            return 0
        source_kind = str((game.get("metadata") or {}).get("source") or "")
        local_record = source_kind == "local-environment"
        edges = [
            (parent_id, child_id)
            for parent_id, parent in list(nodes.items())
            if isinstance(parent, dict)
            for child_id in list(parent.get("children", []))
            if child_id in nodes
        ]
        inserted = 0
        for parent_id, child_id in edges:
            parent = nodes.get(parent_id)
            child = nodes.get(child_id)
            if not isinstance(parent, dict) or not isinstance(child, dict):
                continue
            if child.get("type") == "decision":
                continue
            decisions = self._repair_decisions_for_edge(
                parent,
                child,
                local_record=local_record,
            )
            if decisions is None:
                continue
            decision_source = (
                "recorded_reaction_decision"
                if local_record
                else "inferred_reaction_pass"
            )
            inserted += self._insert_chain(
                game,
                parent_id,
                child_id,
                decisions,
                decision_source,
            )
        return inserted

    def _append_live_node(
        self,
        game: Game,
        response: dict[str, Any],
        seat: int,
    ) -> str | None:
        parent_id = game["currentNodeId"]
        parent_snapshot = game["nodes"][parent_id]["snapshot"]
        if (
            len(
                self.dependencies.build_legal_actions(
                    parent_snapshot,
                    controlled_seat=seat,
                )
            )
            <= 1
        ):
            return None
        action = _decision_action(response, seat, "ai_reaction_decision")
        next_snapshot = _decision_snapshot(parent_snapshot, seat)
        child_id = self.dependencies.create_node(
            game,
            parent_id,
            action,
            next_snapshot,
        )
        child = game["nodes"][child_id]
        child["type"] = "decision"
        child["isDecision"] = True
        self.dependencies.attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        self.dependencies.promote_mainline(game, child_id)
        return child_id

    def _repair_decisions_for_edge(
        self,
        parent: dict[str, Any],
        child: dict[str, Any],
        *,
        local_record: bool,
    ) -> list[tuple[int, dict[str, Any]]] | None:
        snapshot = parent.get("snapshot") or {}
        phase = str(snapshot.get("phase") or "")
        if phase not in ("reaction_window", "kan_reaction_window"):
            return None
        window_field = _reaction_window_field(snapshot)
        reaction_window = snapshot.get(window_field) if window_field else None
        if not isinstance(reaction_window, dict):
            return None
        child_action = child.get("action") or {}
        child_type = str(child_action.get("type") or "")
        if child_type == "none":
            return None

        no_reaction_followups = {"tsumo", "reach_accepted", "ryukyoku"}
        if phase == "kan_reaction_window":
            no_reaction_followups.add("dora")
        if child_type in no_reaction_followups:
            mode = "all_passed"
        elif local_record and child_type in {"chi", "pon", "daiminkan", "hora"}:
            mode = "recorded_responses"
        else:
            return None

        working_snapshot = snapshot
        decisions: list[tuple[int, dict[str, Any]]] = []
        for item in reaction_window.get("reactions", []):
            if not isinstance(item, dict):
                continue
            try:
                seat = self.dependencies.normalize_seat(item.get("seat"))
            except (TypeError, ValueError):
                continue
            response = (
                item.get("response")
                if isinstance(item.get("response"), dict)
                else {}
            )
            response_type = str(response.get("type") or "none")
            if mode == "all_passed" and response_type != "none":
                continue
            if (
                mode == "recorded_responses"
                and seat == child_action.get("actor")
                and response_type == child_type
            ):
                continue
            if (
                len(
                    self.dependencies.build_legal_actions(
                        working_snapshot,
                        controlled_seat=seat,
                    )
                )
                <= 1
            ):
                continue
            decisions.append((seat, response))
            working_snapshot = _decision_snapshot(working_snapshot, seat)
        return decisions

    def _insert_chain(
        self,
        game: Game,
        parent_id: str,
        child_id: str,
        decisions: list[tuple[int, dict[str, Any]]],
        source: str,
    ) -> int:
        if not decisions:
            return 0
        nodes = game["nodes"]
        parent = nodes[parent_id]
        child = nodes[child_id]
        original_children = list(parent.get("children", []))
        if child_id not in original_children:
            return 0

        previous_id = parent_id
        previous_snapshot = parent["snapshot"]
        inserted_ids = []
        for seat, response in decisions:
            node_id = self._allocate_node_id(game)
            action = _decision_action(response, seat, source)
            next_snapshot = _decision_snapshot(previous_snapshot, seat)
            nodes[node_id] = {
                "id": node_id,
                "type": "decision",
                "parentId": previous_id,
                "children": [],
                "mainChildId": None,
                "action": action,
                "actor": seat,
                "isDecision": True,
                "snapshot": next_snapshot,
                "analysisCache": {},
                "depth": int(nodes[previous_id].get("depth", 0)) + 1,
            }
            if previous_id != parent_id:
                nodes[previous_id]["children"] = [node_id]
                nodes[previous_id]["mainChildId"] = node_id
            inserted_ids.append(node_id)
            previous_id = node_id
            previous_snapshot = next_snapshot

        first_id = inserted_ids[0]
        parent["children"] = [
            first_id if value == child_id else value
            for value in original_children
        ]
        if parent.get("mainChildId") == child_id:
            parent["mainChildId"] = first_id
        nodes[previous_id]["children"] = [child_id]
        nodes[previous_id]["mainChildId"] = child_id
        child["parentId"] = previous_id
        self._shift_subtree_depth(game, child_id, len(inserted_ids))
        game_tree.mark_tree_changed(game)
        return len(inserted_ids)

    @staticmethod
    def _allocate_node_id(game: Game) -> str:
        nodes = game["nodes"]
        node_id = f"n_{game['nextNodeIndex']}"
        game["nextNodeIndex"] += 1
        while node_id in nodes:
            node_id = f"n_{game['nextNodeIndex']}"
            game["nextNodeIndex"] += 1
        return node_id

    @staticmethod
    def _shift_subtree_depth(game: Game, root_id: str, delta: int) -> None:
        pending = [root_id]
        seen = set()
        while pending:
            node_id = pending.pop()
            if node_id in seen:
                continue
            seen.add(node_id)
            node = game.get("nodes", {}).get(node_id)
            if not isinstance(node, dict):
                continue
            node["depth"] = int(node.get("depth", 0)) + delta
            pending.extend(node.get("children", []))
