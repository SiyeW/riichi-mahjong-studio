"""Speculative play-ahead coordination for live play mode."""

from __future__ import annotations

import copy
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable

import play_prefetch_runtime
from analysis_cache import (
    OPPONENT_ANALYSIS_CACHE_FIELD,
    attach_analysis_context,
    cache_key_context,
    compact_opponent_analysis,
    prune_stale_cache_entries,
    register_analysis_source,
)
from play_prefetch_runtime import PlayPrefetchRuntime
from service_helpers import now_iso


@dataclass
class PlayPrefetchDependencies:
    build_mjai_stream_bundle: Callable[..., dict[str, Any]]
    build_legal_actions: Callable[..., list[dict[str, Any]]]
    build_state: Callable[..., dict[str, Any]]
    is_read_only_game: Callable[[dict[str, Any]], bool]
    find_existing_child: Callable[..., str | None]
    create_node: Callable[..., str]
    attach_mainline: Callable[..., None]
    promote_mainline: Callable[..., None]
    emit: Callable[[dict[str, Any]], None]


class PlayPrefetchSession:
    """Own speculative game state, background work and cache commits."""

    def __init__(
        self,
        state: dict[str, Any],
        state_lock: Any,
        opponent_predictions: Any,
        engine_management: Any,
        opponent_analysis: Any,
        decision_analysis: Any,
        auto_analysis: Any,
        game_flow: Any,
        dependencies: PlayPrefetchDependencies,
    ) -> None:
        self.state = state
        self.state_lock = state_lock
        self.opponent_predictions = opponent_predictions
        self.engine_management = engine_management
        self.opponent_analysis = opponent_analysis
        self.decision_analysis = decision_analysis
        self.auto_analysis = auto_analysis
        self.game_flow = game_flow
        self.dependencies = dependencies
        self.runtime = PlayPrefetchRuntime()
        self.executor = ThreadPoolExecutor(max_workers=1)

    def active_draft(self):
        return getattr(self.runtime.local, "game", None)

    def has_active_draft(self):
        return self.active_draft() is not None

    def is_user_barrier(self, snapshot):
        if snapshot.get("phase") in ("game_end", "round_result", "match_end"):
            return True
        return bool(self.dependencies.build_legal_actions(snapshot, controlled_seat=self.state["controlledSeat"]))

    def owns_opponent(self, actual_node_id):
        return self.runtime.owns_opponent(actual_node_id)

    def owns_decision(self, actual_node_id, analysis_key):
        def expected_key(context, node):
            return self.decision_analysis.cache_key_for(
                context["seat"],
                node["snapshot"],
                context["modelPath"],
            )

        return self.runtime.owns_decision(
            actual_node_id,
            analysis_key,
            expected_key,
        )

    def current_status(self):
        return self.runtime.current_status(self.state.get("game"))

    def cancel(self):
        self.runtime.cancel()

    def _emit_ready(self, context, draft_node_id):
        with self.runtime.lock:
            if self.runtime.context is not context:
                return
            actual_node_id = play_prefetch_runtime.actual_node_id(context, draft_node_id)
            if actual_node_id is None:
                return
            payload = {
                "type": "play_prefetch_ready",
                "gameId": context["gameId"],
                "nodeId": actual_node_id,
                "generation": context["generation"],
                "timestamp": now_iso(),
            }
        self.dependencies.emit(payload)

    def _fail(self, context, error):
        game = self.state.get("game")
        actual_node_id = game.get("currentNodeId") if isinstance(game, dict) else None
        notification_node_id = self.runtime.fail(
            context,
            error,
            actual_node_id,
        )
        if notification_node_id is not None:
            self._emit_ready(context, notification_node_id)

    def _commit_opponent_result(self, context, draft_node_id):
        result = context.get("opponentResults", {}).get(draft_node_id)
        actual_node_id = play_prefetch_runtime.actual_node_id(context, draft_node_id)
        if not isinstance(result, dict) or actual_node_id is None:
            return False
        if draft_node_id not in context.get("committedNodeIds", set()):
            return False

        game = self.state.get("game")
        if (
            not isinstance(game, dict)
            or game.get("gameId") != context.get("gameId")
            or self.runtime.context is not context
        ):
            return False
        node = game.get("nodes", {}).get(actual_node_id)
        if not isinstance(node, dict):
            return False

        input_mode = str(context.get("opponentInputMode") or "public")
        cache_key = self.opponent_analysis.build_cache_key(context["seat"], input_mode)
        cache = node.setdefault(OPPONENT_ANALYSIS_CACHE_FIELD, {})
        compact = compact_opponent_analysis(result)
        if cache.get(cache_key) == compact:
            return True
        source = self.engine_management.opponent_source(include_display_name=True)
        expected_source_id = (cache_key_context(cache_key) or {}).get("sourceId")
        if expected_source_id != source["id"]:
            return False
        register_analysis_source(game, source, result)
        prune_stale_cache_entries(cache, cache_key)
        cache[cache_key] = compact
        self.auto_analysis.set_timeline_cached("opponent", actual_node_id, True)
        self.dependencies.emit({
            "type": "record_changed",
            "gameId": context["gameId"],
            "change": "opponent_analysis_cache",
            "timestamp": now_iso(),
        })
        if (
            game.get("currentNodeId") == actual_node_id
            and self.state.get("opponentAnalysisEnabled")
        ):
            analysis_context = {
                "gameId": context["gameId"],
                "nodeId": actual_node_id,
                "seat": context["seat"],
                "inputMode": input_mode,
                "cacheKey": cache_key,
                "cacheEpoch": self.engine_management.opponent_cache_epoch,
            }
            self.dependencies.emit({
                "type": "opponent_analysis_ready",
                "gameId": context["gameId"],
                "nodeId": actual_node_id,
                "seat": context["seat"],
                "opponentAnalysis": attach_analysis_context(result, analysis_context),
                "timestamp": now_iso(),
            })
        return True

    def _complete_opponent(self, generation, draft_node_id, result):
        if not isinstance(result, dict) or result.get("status") != "ready":
            return
        with self.state_lock:
            with self.runtime.lock:
                context = self.runtime.context
                if (
                    not isinstance(context, dict)
                    or context.get("generation") != generation
                ):
                    return
                context["opponentPending"].discard(draft_node_id)
                context["opponentResults"][draft_node_id] = compact_opponent_analysis(result)
            self._commit_opponent_result(context, draft_node_id)

    def _schedule_opponent(self, context, draft_node_id):
        if not self.state.get("opponentAnalysisEnabled"):
            return
        with self.runtime.lock:
            if (
                self.runtime.context is not context
                or draft_node_id in context["opponentPending"]
                or draft_node_id in context["opponentResults"]
            ):
                return
            if draft_node_id in context["committedNodeIds"]:
                return
            context["opponentPending"].add(draft_node_id)

        draft_game = context["draftGame"]
        node = draft_game.get("nodes", {}).get(draft_node_id)
        if not isinstance(node, dict):
            return
        snapshot = node["snapshot"]
        seat = context["seat"]
        input_mode = str(context.get("opponentInputMode") or "public")
        prediction_bundle = self.dependencies.build_mjai_stream_bundle(
            draft_game,
            draft_node_id,
            seat,
            reveal_all=input_mode == "full-information",
        )
        target_bundle = self.dependencies.build_mjai_stream_bundle(
            draft_game,
            draft_node_id,
            seat,
            reveal_all=True,
        )
        request_context = {
            "gameId": context["gameId"],
            "nodeId": f"prefetch:{context['generation']}:{draft_node_id}",
            "seat": seat,
            "inputMode": input_mode,
            "cacheKey": self.opponent_analysis.cache_key(seat),
            "cacheEpoch": self.engine_management.opponent_cache_epoch,
        }
        accepted = self.opponent_predictions.request_background_predict(
            snapshot,
            seat,
            input_mode=input_mode,
            context=request_context,
            on_complete=lambda result: self._complete_opponent(
                context["generation"],
                draft_node_id,
                result,
            ),
            mjai_events=prediction_bundle["events"],
            mjai_prefix_hashes=prediction_bundle["prefixHashes"],
            mjai_events_hash=prediction_bundle["eventHash"],
            target_mjai_events=target_bundle["events"],
            target_mjai_prefix_hashes=target_bundle["prefixHashes"],
            target_mjai_events_hash=target_bundle["eventHash"],
        )
        if not accepted:
            with self.runtime.lock:
                if self.runtime.context is context:
                    context["opponentPending"].discard(draft_node_id)

    def _commit_decision_result(self, context, draft_node_id):
        result = context.get("decisionResults", {}).get(draft_node_id)
        actual_node_id = play_prefetch_runtime.actual_node_id(context, draft_node_id)
        if not isinstance(result, dict) or actual_node_id is None:
            return False
        if draft_node_id not in context.get("committedNodeIds", set()):
            return False

        game = self.state.get("game")
        if (
            not isinstance(game, dict)
            or game.get("gameId") != context.get("gameId")
            or self.runtime.context is not context
            or not self.state.get("decisionRecommendationsEnabled", True)
        ):
            return False
        node = game.get("nodes", {}).get(actual_node_id)
        if not isinstance(node, dict):
            return False
        cache_key = self.decision_analysis.cache_key_for(
            context["seat"],
            node["snapshot"],
            context["modelPath"],
        )
        cache = node.setdefault("analysisCache", {})
        if cache.get(cache_key) == result:
            return True
        stored = self.decision_analysis.store(
            game,
            node,
            cache_key,
            result,
            source=self.engine_management.decision_source(context["modelPath"]),
        )
        if stored is None:
            return False
        tree_updates = self.decision_analysis.update_child_comparisons(
            game,
            node,
            result,
            context["seat"],
        )
        self.dependencies.emit({
            "type": "analysis_ready",
            "cacheEpoch": self.engine_management.decision_cache_epoch,
            "nodeId": actual_node_id,
            "gameId": context["gameId"],
            "analysisKey": cache_key,
            "analysis": copy.deepcopy(result),
            "treeComparisons": tree_updates,
            "treeRevision": int(game.get("treeRevision", 0)),
            "state": self.dependencies.build_state(consume_thinking_time=False),
            "timestamp": now_iso(),
        })
        self.dependencies.emit({
            "type": "record_changed",
            "gameId": context["gameId"],
            "change": "decision_analysis_cache",
            "timestamp": now_iso(),
        })
        return True

    def _run_decision(self, context, draft_node_id):
        if not self.state.get("decisionRecommendationsEnabled", True):
            return
        node = context["draftGame"].get("nodes", {}).get(draft_node_id)
        if not isinstance(node, dict):
            return
        legal_actions = self.dependencies.build_legal_actions(
            node["snapshot"],
            controlled_seat=context["seat"],
        )
        if not legal_actions:
            return
        cache_key = self.decision_analysis.cache_key_for(
            context["seat"],
            node["snapshot"],
            context["modelPath"],
        )
        with self.runtime.lock:
            if self.runtime.context is not context:
                return
            context["decisionPending"].add(draft_node_id)
        try:
            result = self.auto_analysis.run_decision_item(
                context["draftGame"],
                {
                    "nodeId": draft_node_id,
                    "cacheKey": cache_key,
                },
                context["seat"],
                context["modelPath"],
            )
        except Exception:
            return
        finally:
            with self.runtime.lock:
                if self.runtime.context is context:
                    context["decisionPending"].discard(draft_node_id)
        with self.state_lock:
            with self.runtime.lock:
                if self.runtime.context is not context:
                    return
                context["decisionResults"][draft_node_id] = copy.deepcopy(result)
            self._commit_decision_result(context, draft_node_id)

    def _capture_step(self, context):
        return self.runtime.capture_step(context, self.game_flow.advance)

    def _run(self, generation):
        with self.runtime.lock:
            context = self.runtime.context
            if (
                not isinstance(context, dict)
                or context.get("generation") != generation
            ):
                return

        try:
            for _ in range(256):
                with self.runtime.lock:
                    if self.runtime.context is not context:
                        return
                    draft_node_id = context["draftGame"]["currentNodeId"]
                snapshot = context["draftGame"]["nodes"][draft_node_id]["snapshot"]
                if self.is_user_barrier(snapshot):
                    if snapshot.get("phase") not in ("game_end", "round_result", "match_end"):
                        self._schedule_opponent(context, draft_node_id)
                        self._run_decision(context, draft_node_id)
                    self.runtime.finish(context)
                    return

                self._schedule_opponent(context, draft_node_id)
                step = self._capture_step(context)
                if step is None:
                    self._fail(
                        context,
                        "Play prefetch could not advance the deterministic game state.",
                    )
                    return

                should_emit = self.runtime.append_step(context, step)
                if should_emit is None:
                    return
                if should_emit:
                    self._emit_ready(context, step["beforeNodeId"])

            raise RuntimeError("Play prefetch exceeded 256 automatic steps.")
        except Exception as error:  # pylint: disable=broad-except
            self._fail(context, error)

    def start(self):
        self.cancel()
        game = self.state.get("game")
        if (
            self.state.get("mode") != "play"
            or not self.state.get("gameLoaded")
            or not isinstance(game, dict)
            or self.dependencies.is_read_only_game(game)
            or game.get("pendingReview")
        ):
            return self.current_status()
        snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
        if snapshot.get("phase") in ("game_end", "round_result", "match_end"):
            return self.current_status()
        if self.is_user_barrier(snapshot):
            return self.current_status()

        draft_game = play_prefetch_runtime.create_draft(game)
        generation, context = self.runtime.start({
            "gameId": game.get("gameId"),
            "seat": int(self.state["controlledSeat"]),
            "modelPath": self.engine_management.action_weight_path(),
            "opponentInputMode": self.opponent_analysis.input_mode(),
            "draftGame": draft_game,
            "steps": deque(),
            "nodeIdMap": {game["currentNodeId"]: game["currentNodeId"]},
            "committedNodeIds": {game["currentNodeId"]},
            "opponentPending": set(),
            "opponentResults": {},
            "decisionPending": set(),
            "decisionResults": {},
            "running": True,
            "finished": False,
            "error": None,
        })
        self.executor.submit(self._run, generation)
        return self.current_status()

    def _commit_step(self):
        if self.state.get("mode") != "play":
            return None
        with self.runtime.lock:
            context = self.runtime.context
            game = self.state.get("game")
            if (
                not isinstance(context, dict)
                or not isinstance(game, dict)
                or game.get("gameId") != context.get("gameId")
                or not context["steps"]
            ):
                return None
            step = context["steps"][0]
            actual_before_id = play_prefetch_runtime.actual_node_id(
                context,
                step["beforeNodeId"],
            )
            if actual_before_id != game.get("currentNodeId"):
                return None
            current_node = game["nodes"].get(actual_before_id)
            if (
                not isinstance(current_node, dict)
                or current_node.get("snapshot") != step["beforeSnapshot"]
            ):
                context["error"] = "The committed game state diverged from its prefetch base."
                context["running"] = False
                context["finished"] = True
                context["steps"].clear()
                return None
            context["steps"].popleft()

        current_node["snapshot"] = copy.deepcopy(step["afterBaseSnapshot"])
        actual_cursor_id = actual_before_id
        committed_draft_ids = []
        for draft_node in step["transitionNodes"]:
            draft_node_id = draft_node["id"]
            action = copy.deepcopy(draft_node.get("action") or {})
            existing_id = self.dependencies.find_existing_child(game, actual_cursor_id, action)
            if existing_id is None:
                actual_child_id = self.dependencies.create_node(
                    game,
                    actual_cursor_id,
                    action,
                    copy.deepcopy(draft_node["snapshot"]),
                )
            else:
                actual_child_id = existing_id
                game["nodes"][actual_child_id]["snapshot"] = copy.deepcopy(
                    draft_node["snapshot"]
                )
            self.dependencies.attach_mainline(actual_cursor_id, actual_child_id)
            game["currentNodeId"] = actual_child_id
            self.dependencies.promote_mainline(game, actual_child_id)
            with self.runtime.lock:
                if self.runtime.context is not context:
                    return None
                context["nodeIdMap"][draft_node_id] = actual_child_id
                context["committedNodeIds"].add(draft_node_id)
            committed_draft_ids.append(draft_node_id)
            actual_cursor_id = actual_child_id

        game["currentNodeId"] = actual_cursor_id
        if isinstance(step.get("afterMatchState"), dict):
            game["matchState"] = copy.deepcopy(step["afterMatchState"])
        if not step["transitionNodes"]:
            with self.runtime.lock:
                context["committedNodeIds"].add(step["afterNodeId"])

        for draft_node_id in committed_draft_ids or [step["afterNodeId"]]:
            self._commit_opponent_result(context, draft_node_id)
            self._commit_decision_result(context, draft_node_id)

        return {
            "committed": True,
            **self.current_status(),
        }

    def advance_game(self, game):
        snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
        if self.state.get("mode") != "play":
            raise ValueError("Game actions are only available in play mode.")

        if snapshot.get("phase") in ("game_end", "round_result"):
            self.cancel()
            self.game_flow.advance(game)
            self.start()
            return {
                "committed": True,
                **self.current_status(),
            }
        if snapshot.get("phase") == "match_end":
            return {
                "committed": False,
                **self.current_status(),
            }

        committed = self._commit_step()
        if committed is not None:
            return committed

        status = self.current_status()
        if not status["waiting"] and not status["ready"] and not status.get("error"):
            self.start()
            committed = self._commit_step()
            if committed is not None:
                return committed
            status = self.current_status()

        if status.get("error"):
            self.cancel()
            self.game_flow.advance(game)
            self.start()
            return {
                "committed": True,
                "fallback": True,
                **self.current_status(),
            }

        return {
            "committed": False,
            **status,
        }
