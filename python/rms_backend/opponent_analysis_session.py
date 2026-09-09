"""Current-position opponent-analysis request and cache coordination."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Callable, MutableMapping, Optional

from .analysis_cache import (
    OPPONENT_ANALYSIS_CACHE_FIELD,
    attach_analysis_context,
    compact_opponent_analysis,
    find_stale_cache_entry,
    opponent_analysis_cache_key,
    prune_stale_cache_entries,
    register_analysis_source,
    same_analysis_context,
)
from .service_helpers import now_iso


@dataclass(frozen=True)
class OpponentAnalysisDependencies:
    build_mjai_stream_bundle: Callable[..., dict[str, Any]]
    play_prefetch_owns: Callable[[str], bool]
    auto_analysis_owns: Callable[[str, str], bool]
    set_timeline_cached: Callable[[str, str, bool], None]
    get_auto_analysis_status: Callable[..., dict[str, Any]]
    emit: Callable[[dict[str, Any]], None]


class OpponentAnalysisSession:
    """Own opponent-analysis context, request deduplication and cache writes."""

    def __init__(
        self,
        state: MutableMapping[str, Any],
        state_lock: Any,
        predictions: Any,
        engine_management: Any,
        dependencies: OpponentAnalysisDependencies,
    ) -> None:
        self.state = state
        self.state_lock = state_lock
        self.predictions = predictions
        self.engine_management = engine_management
        self.dependencies = dependencies

    def input_mode(self) -> str:
        supported = set(self.predictions.supported_input_modes())
        if self.state.get("visibleHands") and "full-information" in supported:
            return "full-information"
        return "public"

    def cache_key(self, seat: Optional[int] = None) -> str:
        resolved_seat = (
            int(self.state["controlledSeat"]) if seat is None else int(seat)
        )
        return self.build_cache_key(resolved_seat, self.input_mode())

    def build_cache_key(self, seat: int, input_mode: str) -> str:
        return opponent_analysis_cache_key(
            seat,
            input_mode,
            self.engine_management.opponent_source(),
        )

    def current_context(self) -> Optional[dict[str, Any]]:
        game = self.state.get("game")
        if not self.state.get("gameLoaded") or not isinstance(game, dict):
            return None
        node_id = game.get("currentNodeId")
        if node_id not in game.get("nodes", {}):
            return None
        seat = int(self.state["controlledSeat"])
        input_mode = self.input_mode()
        return {
            "gameId": game.get("gameId"),
            "nodeId": node_id,
            "seat": seat,
            "inputMode": input_mode,
            "cacheKey": self.cache_key(seat),
            "cacheEpoch": self.engine_management.opponent_cache_epoch,
        }

    def cache_result(self, result: Any, *, require_current: bool) -> bool:
        with self.state_lock:
            return self._cache_result_locked(result, require_current=require_current)

    def _cache_result_locked(self, result: Any, *, require_current: bool) -> bool:
        context = result.get("context") if isinstance(result, dict) else None
        if not isinstance(context, dict) or result.get("status") != "ready":
            return False
        if (
            context.get("cacheEpoch")
            != self.engine_management.opponent_cache_epoch
        ):
            return False

        compact = compact_opponent_analysis(result)
        changed = False
        is_current = same_analysis_context(context, self.current_context())
        seat = int(context.get("seat", -1))
        if require_current and not is_current:
            return False
        game = self.state.get("game")
        if not isinstance(game, dict) or game.get("gameId") != context.get("gameId"):
            return False
        node = game.get("nodes", {}).get(context.get("nodeId"))
        cache_key = str(context.get("cacheKey") or "")
        if (
            not isinstance(node, dict)
            or not cache_key
            or cache_key != self.cache_key(seat)
        ):
            return False

        source = self.engine_management.opponent_source(include_display_name=True)
        register_analysis_source(game, source, result)
        cache = node.setdefault(OPPONENT_ANALYSIS_CACHE_FIELD, {})
        prune_stale_cache_entries(cache, cache_key)
        if cache.get(cache_key) != compact:
            cache[cache_key] = compact
            changed = True

        if changed:
            self.dependencies.set_timeline_cached(
                "opponent", str(context.get("nodeId") or ""), True
            )
            self.dependencies.emit(
                {
                    "type": "record_changed",
                    "gameId": context.get("gameId"),
                    "change": "opponent_analysis_cache",
                    "timestamp": now_iso(),
                }
            )
        if is_current and self.state.get("opponentAnalysisEnabled"):
            self.dependencies.emit(
                {
                    "type": "opponent_analysis_ready",
                    "gameId": context.get("gameId"),
                    "nodeId": context.get("nodeId"),
                    "seat": seat,
                    "opponentAnalysis": attach_analysis_context(compact, context),
                    "autoAnalysis": self.dependencies.get_auto_analysis_status(
                        include_timeline=self.state.get("mode") == "research"
                    ),
                    "timestamp": now_iso(),
                }
            )
        return True

    def _store_result(self, result: Any) -> None:
        self.cache_result(result, require_current=True)

    def request_current(self, snapshot: Any = None) -> bool:
        with self.state_lock:
            if not self.state.get("opponentAnalysisEnabled"):
                return False
            context = self.current_context()
            if context is None:
                return False
            self.predictions.set_latest_context(context)
            game = self.state["game"]
            node = game["nodes"][context["nodeId"]]
            if context["cacheKey"] in node.get(OPPONENT_ANALYSIS_CACHE_FIELD, {}):
                return False
            if self.dependencies.play_prefetch_owns(context["nodeId"]):
                return False
            if self.predictions.has_request(context):
                return False
            if self.dependencies.auto_analysis_owns("opponent", context["nodeId"]):
                return False
            input_mode = context["inputMode"]
            prediction_bundle = self.dependencies.build_mjai_stream_bundle(
                game,
                context["nodeId"],
                context["seat"],
                reveal_all=input_mode == "full-information",
            )
            target_bundle = self.dependencies.build_mjai_stream_bundle(
                game,
                context["nodeId"],
                context["seat"],
                reveal_all=True,
            )
            self.predictions.request_predict(
                snapshot if snapshot is not None else node["snapshot"],
                context["seat"],
                self.state["visibleHands"],
                input_mode=input_mode,
                context=context,
                on_complete=self._store_result,
                mjai_events=prediction_bundle["events"],
                mjai_prefix_hashes=prediction_bundle["prefixHashes"],
                mjai_events_hash=prediction_bundle["eventHash"],
                target_mjai_events=target_bundle["events"],
                target_mjai_prefix_hashes=target_bundle["prefixHashes"],
                target_mjai_events_hash=target_bundle["eventHash"],
            )
            return True

    def current(self) -> dict[str, Any]:
        if not self.state.get("opponentAnalysisEnabled"):
            return {"status": "disabled", "predictions": {}, "ground_truth": {}}
        context = self.current_context()
        if context is None:
            return {"status": "unavailable", "predictions": {}, "ground_truth": {}}

        latest = self.predictions.get_latest()
        latest_context = latest.get("context") if isinstance(latest, dict) else None
        if (
            same_analysis_context(latest_context, context)
            and latest.get("status") == "ready"
        ):
            return latest

        node = self.state["game"]["nodes"][context["nodeId"]]
        cached = node.get(OPPONENT_ANALYSIS_CACHE_FIELD, {}).get(context["cacheKey"])
        if isinstance(cached, dict):
            return attach_analysis_context(cached, context)

        stale = find_stale_cache_entry(
            self.state["game"],
            node,
            context["cacheKey"],
            OPPONENT_ANALYSIS_CACHE_FIELD,
        )
        if same_analysis_context(latest_context, context):
            if isinstance(stale, dict):
                return attach_analysis_context(stale, context)
            return latest

        self.request_current(node["snapshot"])
        if isinstance(stale, dict):
            return attach_analysis_context(stale, context)
        latest = self.predictions.get_latest()
        latest_context = latest.get("context") if isinstance(latest, dict) else None
        if same_analysis_context(latest_context, context):
            return latest
        return {
            "status": "loading",
            "predictions": {"opponents": {}, "ron_wait": {}},
            "ground_truth": {"opponents": {}, "ron_wait": {}},
            "context": copy.deepcopy(context),
        }
