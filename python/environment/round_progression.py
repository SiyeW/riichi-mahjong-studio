"""Round lifecycle, terminal results, riichi flags and dora progression."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Callable

import snapshot_state
from match_progression import apply_round_result_to_match_state
from rule_kernel import can_declare_ryukyoku
from service_helpers import get_abortive_reason_label
from settlement import (
    compute_abortive_ryukyoku,
    compute_exhaustive_ryukyoku,
    count_yaochu_kinds,
)


@dataclass
class RoundProgressionDependencies:
    create_initial_snapshot: Callable[[dict[str, Any]], dict[str, Any]]
    create_node: Callable[..., str]
    attach_mainline: Callable[..., None]
    promote_mainline: Callable[..., None]


class RoundProgression:
    """Apply state changes that span actions, rounds and the whole match."""

    def __init__(self, dependencies: RoundProgressionDependencies) -> None:
        self.dependencies = dependencies

    @staticmethod
    def build_result_stub(
        snapshot: dict[str, Any],
        *,
        can_renchan: bool = False,
        has_hora: bool = False,
        has_abortive_ryukyoku: bool = False,
        scores: Any = None,
        kyotaku_left: Any = None,
    ) -> dict[str, Any]:
        snapshot_state.sync(snapshot)
        return {
            "roundIndex": snapshot["roundIndex"],
            "canRenchan": bool(can_renchan),
            "hasHora": bool(has_hora),
            "hasAbortiveRyukyoku": bool(has_abortive_ryukyoku),
            "kyotakuLeft": (
                snapshot["kyotaku"]
                if kyotaku_left is None
                else int(kyotaku_left)
            ),
            "scores": copy.deepcopy(
                scores if scores is not None else snapshot["scores"]
            ),
        }

    @staticmethod
    def create_result_snapshot(
        snapshot: dict[str, Any],
        round_result: dict[str, Any],
        next_match_state: dict[str, Any],
    ) -> dict[str, Any]:
        snapshot_state.sync(snapshot)
        result_snapshot = copy.deepcopy(snapshot)
        result_snapshot["phase"] = "round_result"
        event_data = round_result.get("eventData") or {}
        result_snapshot["lastAction"] = {
            "type": "round_result",
            "actor": snapshot.get("dealer", 0),
            "result": {
                "canRenchan": bool(round_result["canRenchan"]),
                "hasHora": bool(round_result["hasHora"]),
                "hasAbortiveRyukyoku": bool(
                    round_result["hasAbortiveRyukyoku"]
                ),
                "eventType": round_result.get("eventType"),
                "eventData": copy.deepcopy(event_data),
                "deltas": copy.deepcopy(event_data.get("deltas", [0, 0, 0, 0])),
                "scores": copy.deepcopy(round_result["scores"]),
                "kyotakuLeft": int(round_result["kyotakuLeft"]),
            },
        }
        result_snapshot["pendingDiscard"] = None
        result_snapshot["reactionWindow"] = None
        result_snapshot["nextMatchState"] = copy.deepcopy(next_match_state)
        snapshot_state.persist(result_snapshot)
        return result_snapshot

    def create_match_end_snapshot(
        self,
        snapshot: dict[str, Any],
        round_result: dict[str, Any],
        ended_match_state: dict[str, Any],
    ) -> dict[str, Any]:
        end_snapshot = self.create_result_snapshot(
            snapshot,
            round_result,
            ended_match_state,
        )
        end_snapshot["phase"] = "match_end"
        end_snapshot["lastAction"] = {
            "type": "match_result",
            "actor": ended_match_state.get("dealer", 0),
            "result": {
                "scores": copy.deepcopy(
                    ended_match_state.get("scores", [25000, 25000, 25000, 25000])
                ),
                "roundIndex": ended_match_state.get("roundIndex", 0),
                "bakaze": ended_match_state.get("bakaze", "E"),
                "kyoku": ended_match_state.get("kyoku", 1),
            },
        }
        return end_snapshot

    def ensure_match_end_node(
        self,
        game: dict[str, Any],
        round_node_id: str,
        round_snapshot: dict[str, Any],
        round_result: dict[str, Any],
        ended_match_state: dict[str, Any],
    ) -> str:
        end_snapshot = self.create_match_end_snapshot(
            round_snapshot,
            round_result,
            ended_match_state,
        )
        end_action = {
            "type": "match_end",
            "source": "system",
            "result": {
                "scores": copy.deepcopy(
                    ended_match_state.get("scores", [25000, 25000, 25000, 25000])
                ),
                "bakaze": ended_match_state.get("bakaze", "E"),
                "kyoku": ended_match_state.get("kyoku", 1),
            },
        }
        end_node_id = self.dependencies.create_node(
            game,
            round_node_id,
            end_action,
            end_snapshot,
        )
        self.dependencies.attach_mainline(round_node_id, end_node_id)
        self.dependencies.promote_mainline(game, end_node_id)
        return end_node_id

    def create_next_kyoku_snapshot(
        self,
        snapshot: dict[str, Any],
        next_match_state: dict[str, Any],
    ) -> dict[str, Any]:
        del snapshot
        next_snapshot = self.dependencies.create_initial_snapshot(next_match_state)
        next_snapshot["lastAction"] = {
            "type": "start_kyoku",
            "actor": next_match_state.get("dealer", 0),
            "bakaze": next_match_state.get("bakaze", "E"),
            "kyoku": next_match_state.get("kyoku", 1),
        }
        return next_snapshot

    @staticmethod
    def has_wall_draw_available(snapshot: dict[str, Any]) -> bool:
        snapshot_state.sync(snapshot)
        return snapshot["drawIndex"] < len(snapshot["wall"])

    @staticmethod
    def has_rinshan_draw_available(snapshot: dict[str, Any]) -> bool:
        snapshot_state.sync(snapshot)
        return bool(snapshot.get("rinshanWall", []))

    @staticmethod
    def reveal_next_dora(snapshot: dict[str, Any]) -> bool:
        next_index = len(snapshot.get("doraIndicators", []))
        dora_stack = snapshot.get("doraIndicatorStack", [])
        ura_stack = snapshot.get("uraIndicatorStack", [])
        if next_index >= len(dora_stack) or next_index >= len(ura_stack):
            return False
        snapshot["doraIndicators"].append(dora_stack[next_index])
        snapshot["uraIndicators"].append(ura_stack[next_index])
        snapshot["actionHistory"].append(
            {"type": "dora", "dora_marker": dora_stack[next_index]}
        )
        snapshot["lastAction"] = {
            "type": "dora",
            "pai": dora_stack[next_index],
        }
        snapshot_state.persist(snapshot)
        return True

    @staticmethod
    def pending_dora_counts(snapshot: dict[str, Any]) -> tuple[int, int]:
        return snapshot_state.get_pending_dora_counts(snapshot)

    @staticmethod
    def set_pending_dora_counts(
        snapshot: dict[str, Any],
        immediate: int,
        delayed: int,
    ) -> None:
        snapshot_state.set_pending_dora_counts(snapshot, immediate, delayed)

    def queue_dora_reveal(
        self,
        snapshot: dict[str, Any],
        *,
        after_action: bool = False,
    ) -> None:
        immediate, delayed = self.pending_dora_counts(snapshot)
        if after_action:
            delayed += 1
        else:
            immediate += 1
        self.set_pending_dora_counts(snapshot, immediate, delayed)

    def promote_delayed_dora_reveal(self, snapshot: dict[str, Any]) -> bool:
        immediate, delayed = self.pending_dora_counts(snapshot)
        if delayed <= 0:
            return False
        self.set_pending_dora_counts(snapshot, immediate + 1, delayed - 1)
        return True

    def has_immediate_dora_reveal(self, snapshot: dict[str, Any]) -> bool:
        immediate, _delayed = self.pending_dora_counts(snapshot)
        return immediate > 0

    def consume_immediate_dora_reveal(self, snapshot: dict[str, Any]) -> bool:
        immediate, delayed = self.pending_dora_counts(snapshot)
        if immediate <= 0:
            return False
        self.set_pending_dora_counts(snapshot, immediate - 1, delayed)
        return True

    def reveal_all_pending_dora(self, snapshot: dict[str, Any]) -> bool:
        immediate, delayed = self.pending_dora_counts(snapshot)
        self.set_pending_dora_counts(snapshot, 0, 0)
        revealed = False
        for _index in range(immediate + delayed):
            revealed = self.reveal_next_dora(snapshot) or revealed
        return revealed

    @staticmethod
    def can_declare_kyuushu_kyuuhai(
        snapshot: dict[str, Any],
        actor: int,
        player_state: Any = None,
    ) -> bool:
        snapshot_state.sync(snapshot)
        if snapshot.get("phase") != "discard":
            return False
        if snapshot.get("currentActor") != actor:
            return False
        if snapshot["rivers"][actor]:
            return False
        if any(snapshot["melds"][seat] for seat in range(4)):
            return False
        if not can_declare_ryukyoku(snapshot, actor, state=player_state):
            return False
        return count_yaochu_kinds(snapshot["hands"][actor]) >= 9

    @staticmethod
    def detect_suufon_renda(snapshot: dict[str, Any]) -> bool:
        snapshot_state.sync(snapshot)
        if any(snapshot["melds"][seat] for seat in range(4)):
            return False
        first_discards = []
        for seat in range(4):
            river = snapshot["rivers"][seat]
            if not river:
                return False
            first_discards.append(river[0].replace("r", ""))
        if len(snapshot.get("actionHistory", [])) < 8:
            return False
        return len(set(first_discards)) == 1 and first_discards[0] in {
            "E",
            "S",
            "W",
            "N",
        }

    @staticmethod
    def detect_suukantsu(snapshot: dict[str, Any]) -> bool:
        snapshot_state.sync(snapshot)
        kan_melds = [
            meld
            for seat_melds in snapshot["melds"]
            for meld in seat_melds
            if meld.get("type") in ("daiminkan", "ankan", "kakan")
        ]
        if len(kan_melds) < 4:
            return False
        return len({int(meld.get("actor", -1)) for meld in kan_melds}) >= 2

    @staticmethod
    def count_accepted_riichis(snapshot: dict[str, Any]) -> int:
        snapshot_state.sync(snapshot)
        return sum(
            1
            for value in snapshot.get(
                "riichiAccepted",
                [False, False, False, False],
            )
            if value
        )

    @staticmethod
    def ensure_ippatsu_flags(snapshot: dict[str, Any]) -> list[bool]:
        flags = snapshot.get("ippatsuEligible")
        if not isinstance(flags, list) or len(flags) != 4:
            flags = [False, False, False, False]
            snapshot["ippatsuEligible"] = flags
        return flags

    def clear_all_ippatsu(self, snapshot: dict[str, Any]) -> None:
        flags = self.ensure_ippatsu_flags(snapshot)
        for seat in range(4):
            flags[seat] = False

    def accept_riichi_for_seat(
        self,
        snapshot: dict[str, Any],
        seat: int,
        *,
        clear_pending: bool = True,
    ) -> bool:
        snapshot_state.sync(snapshot)
        seat = int(seat)
        already_accepted = bool(snapshot["riichiAccepted"][seat])
        if not already_accepted:
            snapshot["riichiAccepted"][seat] = True
            self.ensure_ippatsu_flags(snapshot)[seat] = True
            snapshot["scores"][seat] -= 1000
            snapshot["kyotaku"] += 1
            accepted_event = {"type": "reach_accepted", "actor": seat}
            snapshot["lastAction"] = copy.deepcopy(accepted_event)
            snapshot["actionHistory"].append(copy.deepcopy(accepted_event))
        if clear_pending:
            snapshot["pendingRiichiSeat"] = None
        snapshot_state.persist(snapshot)
        return not already_accepted

    def resolve_pending_riichi_acceptance(self, snapshot: dict[str, Any]) -> bool:
        snapshot_state.sync(snapshot)
        seat = snapshot.get("pendingRiichiSeat")
        if seat is None:
            return False
        return self.accept_riichi_for_seat(snapshot, seat, clear_pending=True)

    @staticmethod
    def mark_abortive_ryukyoku(snapshot: dict[str, Any], reason: str) -> None:
        snapshot_state.sync(snapshot)
        result = compute_abortive_ryukyoku(snapshot, reason)
        snapshot["pendingDiscard"] = None
        snapshot["reactionWindow"] = None
        snapshot["phase"] = "game_end"
        snapshot["lastAction"] = {
            "type": "ryukyoku",
            "actor": snapshot.get("dealer", 0),
            "reason": result["reason"],
            "reasonLabel": result["reasonLabel"],
            "deltas": copy.deepcopy(result["deltas"]),
        }
        snapshot["actionHistory"].append(copy.deepcopy(snapshot["lastAction"]))
        snapshot_state.persist(snapshot)

    def maybe_mark_abortive_ryukyoku(self, snapshot: dict[str, Any]) -> bool:
        if self.count_accepted_riichis(snapshot) >= 4:
            self.mark_abortive_ryukyoku(snapshot, "suucha_riichi")
            return True
        if self.detect_suufon_renda(snapshot):
            self.mark_abortive_ryukyoku(snapshot, "suufon_renda")
            return True
        if self.detect_suukantsu(snapshot):
            self.mark_abortive_ryukyoku(snapshot, "suukantsu")
            return True
        return False

    @staticmethod
    def mark_exhaustive_ryukyoku(snapshot: dict[str, Any]) -> None:
        snapshot_state.sync(snapshot)
        result = compute_exhaustive_ryukyoku(snapshot)
        snapshot["pendingDiscard"] = None
        snapshot["reactionWindow"] = None
        snapshot["phase"] = "game_end"
        snapshot["lastAction"] = {
            "type": "ryukyoku",
            "actor": snapshot.get("dealer", 0),
            "reason": result["reason"],
            "reasonLabel": "荒牌流局",
            "deltas": copy.deepcopy(result["deltas"]),
            "tenpaiSeats": copy.deepcopy(result["tenpaiSeats"]),
        }
        snapshot["actionHistory"].append(copy.deepcopy(snapshot["lastAction"]))
        snapshot_state.persist(snapshot)

    def build_terminal_result(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        snapshot_state.sync(snapshot)
        last_action = snapshot.get("lastAction") or {}
        action_type = last_action.get("type")
        dealer = snapshot.get("dealer", 0)

        if action_type == "hora":
            winner = int(last_action.get("actor", dealer))
            deltas = last_action.get("deltas", [0, 0, 0, 0])
            old_scores = snapshot.get("scores", [25000, 25000, 25000, 25000])
            return {
                "roundIndex": snapshot["roundIndex"],
                "canRenchan": winner == dealer,
                "hasHora": True,
                "hasAbortiveRyukyoku": False,
                "kyotakuLeft": 0,
                "scores": [old_scores[seat] + deltas[seat] for seat in range(4)],
                "eventType": "hora",
                "eventData": {
                    "actor": winner,
                    "target": int(last_action.get("target", winner)),
                    "pai": str(last_action.get("pai") or ""),
                    "deltas": copy.deepcopy(deltas),
                    "han": last_action.get("han"),
                    "fu": last_action.get("fu"),
                    "yaku": copy.deepcopy(last_action.get("yaku", [])),
                    "yakuDetails": copy.deepcopy(last_action.get("yakuDetails", [])),
                    "uraMarkers": copy.deepcopy(last_action.get("uraMarkers", [])),
                    "isOpenHand": last_action.get("isOpenHand"),
                    "cost": copy.deepcopy(last_action.get("cost", {})),
                },
            }

        if action_type == "ryukyoku":
            reason = str(last_action.get("reason") or "ryukyoku")
            if reason == "exhaustive_draw":
                tenpai_seats = copy.deepcopy(last_action.get("tenpaiSeats", []))
                can_renchan = dealer in tenpai_seats
                has_abortive = False
            else:
                tenpai_seats = []
                can_renchan = True
                has_abortive = True
            deltas = last_action.get("deltas", [0, 0, 0, 0])
            old_scores = snapshot.get("scores", [25000, 25000, 25000, 25000])
            return {
                "roundIndex": snapshot["roundIndex"],
                "canRenchan": can_renchan,
                "hasHora": False,
                "hasAbortiveRyukyoku": has_abortive,
                "kyotakuLeft": int(snapshot.get("kyotaku", 0)),
                "scores": [old_scores[seat] + deltas[seat] for seat in range(4)],
                "eventType": "ryukyoku",
                "eventData": {
                    "deltas": copy.deepcopy(deltas),
                    "reason": reason,
                    "reasonLabel": last_action.get("reasonLabel")
                    or get_abortive_reason_label(reason),
                    "tenpaiSeats": tenpai_seats,
                },
            }

        return self.build_result_stub(
            snapshot,
            scores=copy.deepcopy(
                snapshot.get("scores", [25000, 25000, 25000, 25000])
            ),
            kyotaku_left=int(snapshot.get("kyotaku", 0)),
        )

    def commit_system_transition(
        self,
        game: dict[str, Any],
        parent_id: str,
        action: dict[str, Any],
        snapshot: dict[str, Any],
    ) -> str:
        child_id = self.dependencies.create_node(game, parent_id, action, snapshot)
        self.dependencies.attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        self.dependencies.promote_mainline(game, child_id)
        return child_id

    def advance_terminal_round(self, game: dict[str, Any]) -> None:
        current_node_id = game["currentNodeId"]
        current_snapshot = game["nodes"][current_node_id]["snapshot"]
        round_result = self.build_terminal_result(current_snapshot)
        next_match_state = apply_round_result_to_match_state(
            game["matchState"],
            round_result,
        )
        round_snapshot = self.create_result_snapshot(
            current_snapshot,
            round_result,
            next_match_state,
        )
        round_node_id = self.commit_system_transition(
            game,
            current_node_id,
            {
                "type": "round_result",
                "source": "system",
                "result": copy.deepcopy(round_result),
            },
            round_snapshot,
        )
        game["matchState"] = copy.deepcopy(next_match_state)
        if next_match_state.get("ended"):
            self.ensure_match_end_node(
                game,
                round_node_id,
                round_snapshot,
                round_result,
                next_match_state,
            )
