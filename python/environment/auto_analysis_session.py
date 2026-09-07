"""Automatic whole-record analysis orchestration and resource ownership."""

from __future__ import annotations

import copy
import threading
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, MutableMapping, Optional

import auto_analysis_plan
from action_recommendation_adapter import analyze_action_choices, analyze_discard_choices
from analysis_cache import OPPONENT_ANALYSIS_CACHE_FIELD
from auto_analysis_runtime import AutoAnalysisRuntime
from service_helpers import now_iso


@dataclass
class AutoAnalysisDependencies:
    play_prefetch_active: Callable[[], bool]
    build_mjai_stream_bundle: Callable[..., dict[str, Any]]
    get_node_legal_actions: Callable[..., list[dict[str, Any]]]
    build_legal_actions: Callable[..., list[dict[str, Any]]]
    sync_snapshot: Callable[[dict[str, Any]], Any]
    ensure_game_loaded: Callable[[], None]
    build_state: Callable[..., dict[str, Any]]
    emit: Callable[[dict[str, Any]], None]
    timer_factory: Callable[..., Any] = threading.Timer


class AutoAnalysisSession:
    """Own the automatic-analysis plan, progress, jobs and reprioritization timer."""

    def __init__(
        self,
        state: MutableMapping[str, Any],
        state_lock: Any,
        action_gateway: Any,
        opponent_predictions: Any,
        engine_management: Any,
        decision_analysis: Any,
        opponent_analysis: Any,
        executor: Any,
        dependencies: AutoAnalysisDependencies,
        *,
        runtime: Optional[AutoAnalysisRuntime] = None,
    ) -> None:
        self.state = state
        self.state_lock = state_lock
        self.action_gateway = action_gateway
        self.opponent_predictions = opponent_predictions
        self.engine_management = engine_management
        self.decision_analysis = decision_analysis
        self.opponent_analysis = opponent_analysis
        self.executor = executor
        self.dependencies = dependencies
        self.runtime = runtime or AutoAnalysisRuntime()

    def invalidate_timeline(self) -> None:
        if self.dependencies.play_prefetch_active():
            return
        self.runtime.invalidate_timeline()

    def _ensure_timeline_locked(
        self,
        game: dict[str, Any],
        seat: int,
        model_path: str,
    ) -> None:
        signature = (
            id(game),
            self.runtime.timeline_structure_revision,
            int(seat),
            str(model_path),
            self.engine_management.decision_source(model_path)["id"],
            self.opponent_analysis.cache_key(seat),
        )
        if self.runtime.timeline_matches(signature):
            return

        round_root_map = auto_analysis_plan.build_round_root_map(game)
        start_node_id = auto_analysis_plan.timeline_start_node(game, round_root_map)
        items = self.build_plan(
            game,
            seat,
            model_path,
            start_node_id=start_node_id,
            round_root_map=round_root_map,
        )
        self.runtime.replace_timeline(signature, items)

    def set_timeline_cached(self, kind: str, node_id: str, cached: bool) -> None:
        self.runtime.set_timeline_cached(kind, node_id, cached)

    def status(self, *, include_timeline: bool = True) -> dict[str, Any]:
        if not include_timeline:
            status = self.runtime.status_snapshot()
            status["timeline"] = ""
            status["timelineReady"] = 0
            return status

        with self.state_lock:
            game = self.state.get("game")
            game_loaded = self.state.get("gameLoaded") and isinstance(game, dict)
            seat = int(self.state.get("controlledSeat", 0))
            model_path = (
                self.engine_management.action_weight_path() if game_loaded else ""
            )
            with self.runtime.lock:
                status = self.runtime.status_snapshot()
                if not game_loaded:
                    status["timeline"] = ""
                    status["timelineReady"] = 0
                    return status
                self._ensure_timeline_locked(game, seat, model_path)
                status["timeline"], status["timelineReady"] = (
                    self.runtime.timeline_progress(
                        status.get("currentModel"),
                        status.get("currentNodeId"),
                    )
                )
                return status

    def emit_progress(self) -> None:
        game = self.state.get("game")
        self.dependencies.emit(
            {
                "type": "auto_analysis_progress",
                "gameId": game.get("gameId") if isinstance(game, dict) else None,
                "autoAnalysis": self.status(),
                "timestamp": now_iso(),
            }
        )

    def build_plan(
        self,
        game: dict[str, Any],
        seat: int,
        model_path: str,
        *,
        start_node_id: Optional[str] = None,
        round_root_map: Optional[dict[str, str]] = None,
    ) -> list[dict[str, Any]]:
        if round_root_map is None:
            round_root_map = auto_analysis_plan.build_round_root_map(game)
        round_order = auto_analysis_plan.order_rounds(
            game,
            game.get("currentNodeId") if start_node_id is None else start_node_id,
            round_root_map,
        )
        opponent_input_mode = self.opponent_analysis.input_mode()
        opponent_cache_key = self.opponent_analysis.cache_key(seat)
        decision_source = self.engine_management.decision_source(model_path)
        items = []
        for round_root_id in round_order:
            for node_id in auto_analysis_plan.order_round_nodes(
                game,
                round_root_id,
                round_root_map,
            ):
                node = game["nodes"][node_id]
                snapshot = node.get("snapshot") or {}
                self.dependencies.sync_snapshot(snapshot)
                phase = snapshot.get("phase")
                if phase in (
                    "draw_or_discard",
                    "discard",
                    "reach_declaration",
                    "reaction_window",
                    "kan_reaction_window",
                ):
                    legal_actions = self.dependencies.get_node_legal_actions(
                        game,
                        node_id,
                        controlled_seat=seat,
                    )
                    if legal_actions:
                        cache_key = self.decision_analysis.cache_key_for(
                            seat,
                            snapshot,
                            model_path,
                        )
                        decision_result = (node.get("analysisCache") or {}).get(
                            cache_key
                        )
                        items.append(
                            {
                                "kind": "decision",
                                "nodeId": node_id,
                                "roundRootId": round_root_id,
                                "cacheKey": cache_key,
                                "source": copy.deepcopy(decision_source),
                                "cached": isinstance(decision_result, dict)
                                and not decision_result.get("error"),
                            }
                        )

                opponent_result = (
                    node.get(OPPONENT_ANALYSIS_CACHE_FIELD) or {}
                ).get(opponent_cache_key)
                items.append(
                    {
                        "kind": "opponent",
                        "nodeId": node_id,
                        "roundRootId": round_root_id,
                        "cacheKey": opponent_cache_key,
                        "inputMode": opponent_input_mode,
                        "cached": isinstance(opponent_result, dict)
                        and opponent_result.get("status") == "ready",
                    }
                )
        return items

    def kind_enabled(self, kind: str) -> bool:
        if kind == "decision":
            return not self.action_gateway.runtime_status().get("unloaded", False)
        return not self.opponent_predictions.runtime_status().get("unloaded", False)

    def owns_item(self, kind: str, node_id: str) -> bool:
        return self.runtime.owns_item(kind, node_id, self.state.get("game"))

    def cancel(
        self,
        message: str = "已停止",
        *,
        emit_progress: bool = True,
        cancel_opponent_analysis: bool = True,
    ) -> dict[str, Any]:
        was_running, future, timer, status = self.runtime.cancel(message)
        if future is not None:
            try:
                future.cancel()
            except Exception:  # pragma: no cover - Future cancellation is best effort
                pass
        if timer is not None:
            timer.cancel()
        if cancel_opponent_analysis:
            self.opponent_predictions.cancel_background()
        if was_running and emit_progress:
            self.emit_progress()
        return status

    def reset_for_game_change(self) -> None:
        self.cancel(
            "牌谱已切换",
            emit_progress=False,
            cancel_opponent_analysis=False,
        )
        self.runtime.invalidate_timeline()
        with self.runtime.lock:
            self.runtime.status.update(
                {
                    "status": "idle",
                    "completed": 0,
                    "total": 0,
                    "cached": 0,
                    "analyzed": 0,
                    "failed": 0,
                    "currentNodeId": None,
                    "currentModel": None,
                    "message": "",
                }
            )

    def run_decision_item(
        self,
        game: dict[str, Any],
        item: dict[str, Any],
        seat: int,
        model_path: str,
    ) -> dict[str, Any]:
        node = game["nodes"][item["nodeId"]]
        snapshot = node["snapshot"]
        stream_bundle = self.dependencies.build_mjai_stream_bundle(
            game,
            item["nodeId"],
            seat,
        )
        legal_actions = self.dependencies.build_legal_actions(
            snapshot,
            controlled_seat=seat,
        )
        if snapshot.get("phase") in (
            "draw_or_discard",
            "discard",
            "reach_declaration",
        ):
            return analyze_discard_choices(
                self.action_gateway,
                snapshot,
                seat,
                model_path,
                mjai_events=stream_bundle["events"],
                mjai_prefix_hashes=stream_bundle["prefixHashes"],
                mjai_events_hash=stream_bundle["eventHash"],
                legal_actions=legal_actions,
                role="auto-analysis",
                position_id=item["nodeId"],
            )
        return analyze_action_choices(
            self.action_gateway,
            snapshot,
            seat,
            model_path,
            mjai_events=stream_bundle["events"],
            mjai_prefix_hashes=stream_bundle["prefixHashes"],
            mjai_events_hash=stream_bundle["eventHash"],
            legal_actions=legal_actions,
            role="auto-analysis",
            position_id=item["nodeId"],
        )

    def complete_item(
        self,
        generation: int,
        item: dict[str, Any],
        result: Optional[dict[str, Any]] = None,
        error: Optional[BaseException | str] = None,
    ) -> None:
        with self.state_lock:
            completed = self._complete_item_locked(generation, item, result, error)
        if completed:
            self.schedule_next(generation)

    def _complete_item_locked(
        self,
        generation: int,
        item: dict[str, Any],
        result: Optional[dict[str, Any]] = None,
        error: Optional[BaseException | str] = None,
    ) -> Optional[bool]:
        context = self.runtime.completion_context(generation, item)
        if context is None or context["game"] is not self.state.get("game"):
            return None
        game = context["game"]
        seat = context["seat"]
        success = False
        tree_updates = []
        node = game.get("nodes", {}).get(item.get("nodeId"))
        if (
            isinstance(node, dict)
            and isinstance(result, dict)
            and not result.get("error")
        ):
            if item.get("kind") == "decision":
                stored = self.decision_analysis.store(
                    game,
                    node,
                    item["cacheKey"],
                    result,
                    source=item.get("source"),
                )
                if stored is not None:
                    self.set_timeline_cached("decision", item.get("nodeId"), True)
                    tree_updates = self.decision_analysis.update_child_comparisons(
                        game,
                        node,
                        result,
                        seat,
                    )
                    success = True
            else:
                success = self.opponent_analysis.cache_result(
                    result,
                    require_current=False,
                )

        context = self.runtime.complete_item(generation, item, success, error)
        if context is None:
            return None

        if success:
            if item.get("kind") == "decision":
                self.dependencies.emit(
                    {
                        "type": "record_changed",
                        "gameId": context["gameId"],
                        "change": "decision_analysis_cache",
                        "timestamp": now_iso(),
                    }
                )
            if (
                item.get("kind") == "decision"
                and context["game"].get("currentNodeId") == item.get("nodeId")
            ):
                self.dependencies.emit(
                    {
                        "type": "analysis_ready",
                        "cacheEpoch": self.engine_management.decision_cache_epoch,
                        "nodeId": item["nodeId"],
                        "gameId": context["gameId"],
                        "analysisKey": item["cacheKey"],
                        "analysis": result,
                        "treeComparisons": tree_updates,
                        "treeRevision": int(
                            context["game"].get("treeRevision", 0)
                        ),
                        "state": self.dependencies.build_state(),
                        "timestamp": now_iso(),
                    }
                )
        if tree_updates:
            self.dependencies.emit(
                {
                    "type": "auto_analysis_tree_updates",
                    "cacheEpoch": self.engine_management.decision_cache_epoch,
                    "gameId": context["gameId"],
                    "treeComparisons": tree_updates,
                    "treeRevision": int(context["game"].get("treeRevision", 0)),
                    "timestamp": now_iso(),
                }
            )
        self.emit_progress()
        return True

    def _on_decision_complete(
        self,
        generation: int,
        item: dict[str, Any],
        future: Any,
    ) -> None:
        try:
            self.complete_item(generation, item, result=future.result())
        except Exception as exc:  # pylint: disable=broad-except
            self.complete_item(generation, item, error=exc)

    def _on_opponent_complete(
        self,
        generation: int,
        item: dict[str, Any],
        result: Any,
    ) -> None:
        status = str(result.get("status") or "") if isinstance(result, dict) else ""
        error = None if status == "ready" else status or "对手分析未返回结果"
        self.complete_item(generation, item, result=result, error=error)

    def _extend_plan(self, context: dict[str, Any]) -> bool:
        items = self.build_plan(
            context["game"],
            context["seat"],
            context["modelPath"],
        )
        return self.runtime.extend_plan(context, items, self.kind_enabled)

    def reprioritize(
        self,
        game: dict[str, Any],
        start_node_id: str,
        expected_serial: Optional[int] = None,
    ) -> bool:
        changed = False
        cached_updates = False
        with self.runtime.lock:
            context = self.runtime.context
            if (
                not isinstance(context, dict)
                or self.runtime.status.get("status") != "running"
                or context.get("game") is not game
            ):
                return False
            if (
                expected_serial is not None
                and expected_serial != self.runtime.reprioritize_serial
            ):
                return False
            if context.get("treeRevision") != int(game.get("treeRevision", 0)):
                changed = self._extend_plan(context) or changed
            context_generation = context.get("generation")

        navigation_rank = auto_analysis_plan.navigation_rank(game, start_node_id)

        with self.runtime.lock:
            context = self.runtime.context
            if (
                not isinstance(context, dict)
                or context.get("generation") != context_generation
                or context.get("game") is not game
                or self.runtime.status.get("status") != "running"
            ):
                return False
            if (
                expected_serial is not None
                and expected_serial != self.runtime.reprioritize_serial
            ):
                return False
            reordered, cached_updates = self.runtime.reprioritize_pending(
                context,
                game,
                navigation_rank,
                auto_analysis_plan.item_is_cached,
                self.kind_enabled,
            )
            changed = reordered or changed

        if cached_updates:
            self.emit_progress()
        return changed

    def schedule_reprioritization(
        self,
        game: dict[str, Any],
        start_node_id: str,
    ) -> bool:
        with self.runtime.lock:
            context = self.runtime.context
            if (
                not isinstance(context, dict)
                or self.runtime.status.get("status") != "running"
                or context.get("game") is not game
            ):
                return False

            focused = []
            remaining = []
            for item in context["pending"]:
                if item.get("nodeId") == start_node_id:
                    focused.append(item)
                else:
                    remaining.append(item)
            context["pending"] = deque(focused + remaining)

            previous_timer = self.runtime.reprioritize_timer
            self.runtime.reprioritize_serial += 1
            serial = self.runtime.reprioritize_serial

            def apply_settled_focus() -> None:
                with self.runtime.lock:
                    if serial != self.runtime.reprioritize_serial:
                        return
                    self.runtime.reprioritize_timer = None
                self.reprioritize(
                    game,
                    start_node_id,
                    expected_serial=serial,
                )

            timer = self.dependencies.timer_factory(
                self.runtime.reprioritize_delay_s,
                apply_settled_focus,
            )
            timer.daemon = True
            self.runtime.reprioritize_timer = timer

        if previous_timer is not None:
            previous_timer.cancel()
        timer.start()
        return True

    def schedule_next(self, generation: int) -> None:
        self.runtime.schedule(generation, self._dispatch_next)

    def _dispatch_next(self, generation: int) -> None:
        while True:
            with self.state_lock:
                with self.runtime.lock:
                    selection, item, context = self.runtime.take_next_item(
                        generation,
                        self.state.get("game"),
                        auto_analysis_plan.item_is_cached,
                        self.kind_enabled,
                    )
                    if selection == "inactive":
                        return
                    game = context["game"]
                    if selection == "empty":
                        if self._extend_plan(context) and context["pending"]:
                            continue
                        self.runtime.finish(generation)
                        finished = True
                    else:
                        finished = False
                        seat = context["seat"]
                        model_path = context["modelPath"]
                        game_id = context["gameId"]

            if finished:
                self.emit_progress()
                return

            if item["kind"] == "decision":
                try:
                    future = self.executor.submit(
                        self.run_decision_item,
                        game,
                        item,
                        seat,
                        model_path,
                    )
                except Exception as exc:  # pylint: disable=broad-except
                    with self.state_lock:
                        completed = self._complete_item_locked(
                            generation,
                            item,
                            error=exc,
                        )
                    if not completed:
                        return
                    continue
                self.runtime.set_future(generation, future)
                future.add_done_callback(
                    lambda completed_future, g=generation, current_item=item: (
                        self._on_decision_complete(g, current_item, completed_future)
                    )
                )
                self.emit_progress()
                return

            input_mode = str(item.get("inputMode") or "public")
            opponent_context = {
                "gameId": game_id,
                "nodeId": item["nodeId"],
                "seat": seat,
                "inputMode": input_mode,
                "cacheKey": item["cacheKey"],
                "cacheEpoch": self.engine_management.opponent_cache_epoch,
                "autoAnalysisGeneration": generation,
            }
            try:
                prediction_bundle = self.dependencies.build_mjai_stream_bundle(
                    game,
                    item["nodeId"],
                    seat,
                    reveal_all=input_mode == "full-information",
                )
                target_bundle = self.dependencies.build_mjai_stream_bundle(
                    game,
                    item["nodeId"],
                    seat,
                    reveal_all=True,
                )
            except Exception as exc:  # pylint: disable=broad-except
                if self.runtime.is_active(generation, game):
                    self.complete_item(generation, item, error=exc)
                return
            if not self.runtime.is_active(generation, game):
                return
            try:
                accepted = self.opponent_predictions.request_background_predict(
                    game["nodes"][item["nodeId"]]["snapshot"],
                    seat,
                    input_mode=input_mode,
                    context=opponent_context,
                    on_complete=lambda result, g=generation, current_item=item: (
                        self._on_opponent_complete(g, current_item, result)
                    ),
                    mjai_events=prediction_bundle["events"],
                    mjai_prefix_hashes=prediction_bundle["prefixHashes"],
                    mjai_events_hash=prediction_bundle["eventHash"],
                    target_mjai_events=target_bundle["events"],
                    target_mjai_prefix_hashes=target_bundle["prefixHashes"],
                    target_mjai_events_hash=target_bundle["eventHash"],
                )
            except Exception as exc:  # pylint: disable=broad-except
                self.complete_item(generation, item, error=exc)
                return
            if accepted:
                self.emit_progress()
                return
            if not self.kind_enabled("opponent"):
                self.schedule_next(generation)
                return
            self.complete_item(
                generation,
                item,
                error=self.opponent_predictions.activity_error()
                or "对手分析任务重复",
            )
            return

    def start(self) -> dict[str, Any]:
        self.dependencies.ensure_game_loaded()
        self.cancel(emit_progress=False)
        game = self.state["game"]
        seat = int(self.state["controlledSeat"])
        model_path = self.engine_management.action_weight_path()
        items = self.build_plan(game, seat, model_path)
        generation = self.runtime.start(
            game,
            seat,
            model_path,
            items,
            self.kind_enabled,
        )
        self.emit_progress()
        self.schedule_next(generation)
        return self.status()
