"""Current-position opponent-analysis request and cache coordination."""

from __future__ import annotations

from .records.analysis_values import AnalysisReadError

import copy
from dataclasses import dataclass
from typing import Any, Callable, MutableMapping, Optional

from .auto_analysis_plan import is_terminal_analysis_node, preceding_prediction_node
from .analysis_cache import (
    OPPONENT_ANALYSIS_CACHE_FIELD,
    attach_analysis_context,
    compact_opponent_analysis,
    find_stale_cache_entry,
    cache_key_context,
    cache_presentation_metadata,
    opponent_analysis_cache_key,
    prune_stale_cache_entries,
    register_analysis_source,
    same_analysis_context,
)
from .service_helpers import now_iso
from .records.analysis_refs import AnalysisReference


@dataclass(frozen=True)
class OpponentAnalysisDependencies:
    build_mjai_stream_bundle: Callable[..., dict[str, Any]]
    play_prefetch_owns: Callable[[str], bool]
    auto_analysis_owns: Callable[[str, str], bool]
    set_timeline_cached: Callable[[str, str, bool], None]
    get_auto_analysis_status: Callable[..., dict[str, Any]]
    emit: Callable[[dict[str, Any]], None]
    read_presenter: Any = None
    record_access: Any = None
    build_analysis_table: Any = None


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

    def display_input_mode(self, node):
        # Loaded providers govern inference, never access to already saved facts.
        available = getattr(self.predictions, 'accepts_requests', lambda: False)()
        if self.state.get('visibleHands') and not available:
            for key in (node or {}).get(OPPONENT_ANALYSIS_CACHE_FIELD, {}):
                address = cache_key_context(key)
                if address and address['seat'] == int(self.state['controlledSeat']) and address['mode'] == 'full-information':
                    return 'full-information'
        return self.input_mode()

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
        terminal = is_terminal_analysis_node(game["nodes"][node_id])
        seat = int(self.state["controlledSeat"])
        node = game['nodes'][node_id]
        source_node = preceding_prediction_node(game, node_id) if terminal else node
        input_mode = self.display_input_mode(source_node)
        return {
            "gameId": game.get("gameId"),
            "nodeId": node_id,
            "sourceNodeId": (source_node or {}).get('id'),
            "seat": seat,
            "inputMode": input_mode,
            "cacheKey": self.build_cache_key(seat, input_mode),
            "cacheEpoch": self.engine_management.opponent_cache_epoch,
            "terminal": terminal,
        }

    def cache_result(self, result: Any, *, require_current: bool, ticket=None) -> bool:
        with self.state_lock:
            try:
                return self._cache_result_locked(result, require_current=require_current, ticket=ticket)
            finally:
                if ticket is not None:
                    self.dependencies.record_access.cancel(ticket)

    def _cache_result_locked(self, result: Any, *, require_current: bool, ticket=None) -> bool:
        context = result.get("context") if isinstance(result, dict) else None
        if not isinstance(context, dict) or result.get("status") != "ready":
            return False
        if (
            context.get("cacheEpoch")
            != self.engine_management.opponent_cache_epoch
        ):
            return False

        changed = False
        display_context = self.current_context()
        is_current = same_analysis_context(context, display_context)
        if not is_current and display_context and display_context.get('terminal'):
            source_node = preceding_prediction_node(self.state['game'], display_context['nodeId'])
            is_current = bool(source_node and source_node['id'] == context.get('nodeId') and all(
                context.get(key) == display_context.get(key)
                for key in ('gameId', 'seat', 'cacheKey', 'cacheEpoch')))
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
            or is_terminal_analysis_node(node)
            or not cache_key
            or cache_key != self.build_cache_key(seat, context.get('inputMode', 'public'))
        ):
            return False

        source = self.engine_management.opponent_source(include_display_name=True)
        access = self.dependencies.record_access
        if access is not None and access.enabled(game):
            compact = access.store(ticket, game, node, cache_key, result, source)
            if compact is None:
                return False
            changed = True
        else:
            compact = compact_opponent_analysis(result)
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
            presented = self._present_cached(compact, display_context, terminal=display_context.get('terminal', False))
            if presented.get('status') == 'loading':
                return True  # The captured read subscription publishes canonical data later.
            self.dependencies.emit(
                {
                    "type": "opponent_analysis_ready",
                    "gameId": context.get("gameId"),
                    "nodeId": display_context.get("nodeId"),
                    "seat": seat,
                    "opponentAnalysis": presented,
                    "autoAnalysis": self.dependencies.get_auto_analysis_status(
                        include_timeline=self.state.get("mode") == "research"
                    ),
                    "timestamp": now_iso(),
                }
            )
        return True

    def request_current(self, snapshot: Any = None) -> bool:
        with self.state_lock:
            if not self.state.get("opponentAnalysisEnabled"):
                return False
            context = self.current_context()
            if context is None:
                return False
            if context.get("terminal"):
                source = context.get('sourceNodeId')
                if source is None or not getattr(self.predictions, 'accepts_requests', lambda: False)():
                    return False
                # Predict its eligible predecessor, never the resolved display
                # node. Saving keeps the result on that predecessor too.
                context = {**context, 'nodeId': source, 'sourceNodeId': source, 'terminal': False}
                snapshot = None
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
            if not self.predictions.accepts_requests():
                return False
            input_mode = context["inputMode"]
            if input_mode not in self.predictions.supported_input_modes():
                return False
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
            access = self.dependencies.record_access
            ticket = None
            if access is not None and access.enabled(game):
                ticket = access.reserve(game, 'opponent', foreground=True)
                if ticket is None:
                    access.defer(game, 'opponent', self.request_current)
                    return False
            try:
                self.predictions.request_predict(
                    snapshot if snapshot is not None else node["snapshot"],
                    context["seat"],
                    self.state["visibleHands"],
                    input_mode=input_mode,
                    context=context,
                    on_complete=lambda result: self.cache_result(result, require_current=False, ticket=ticket),
                    on_discard=(lambda: access.retire(ticket)) if ticket is not None else None,
                    mjai_events=prediction_bundle["events"],
                    mjai_prefix_hashes=prediction_bundle["prefixHashes"],
                    mjai_events_hash=prediction_bundle["eventHash"],
                    target_mjai_events=target_bundle["events"],
                    target_mjai_prefix_hashes=target_bundle["prefixHashes"],
                    target_mjai_events_hash=target_bundle["eventHash"],
                )
            except Exception:
                if ticket is not None:
                    access.cancel(ticket)
                raise
            return True

    def current(self) -> dict[str, Any]:
        try:
            return self._current()
        except AnalysisReadError as error:
            return {'status': f'prediction_error: {error}', 'error': str(error),
                    'predictions': {}, 'ground_truth': {},
                    'context': {**(self.current_context() or {}), 'dataState': 'failed'}}

    def _current(self) -> dict[str, Any]:
        if not self.state.get("opponentAnalysisEnabled"):
            return {"status": "disabled", "predictions": {}, "ground_truth": {}}
        context = self.current_context()
        if context is None:
            return {"status": "unavailable", "predictions": {}, "ground_truth": {}}
        if context.get("terminal"):
            node = preceding_prediction_node(self.state["game"], context["nodeId"])
            cached = (node or {}).get(OPPONENT_ANALYSIS_CACHE_FIELD, {}).get(context["cacheKey"])
            if not isinstance(cached, dict) and node is not None:
                cached = find_stale_cache_entry(
                    self.state["game"], node, context["cacheKey"], OPPONENT_ANALYSIS_CACHE_FIELD,
                    resolve=False,
                )
            if isinstance(cached, AnalysisReference) or isinstance(cached, dict) and cached.get("status") == "ready":
                return self._present_cached(cached, context, terminal=True)
            self.request_current()
            return {
                "status": "loading", "predictions": {}, "ground_truth": {},
                "context": context,
            }

        node = self.state["game"]["nodes"][context["nodeId"]]
        cached = node.get(OPPONENT_ANALYSIS_CACHE_FIELD, {}).get(context["cacheKey"])
        if isinstance(cached, dict):
            return self._present_cached(cached, context)

        access = self.dependencies.record_access
        if access is not None and access.enabled(self.state['game']):
            stale = find_stale_cache_entry(self.state['game'], node, context['cacheKey'],
                                           OPPONENT_ANALYSIS_CACHE_FIELD, resolve=False)
            self.request_current(node['snapshot'])
            if isinstance(stale, dict):
                return self._present_cached(stale, context)
            error = self.predictions.activity_error()
            status = f'prediction_error: {error}' if error else (
                'loading' if self.predictions.accepts_requests() else 'unavailable')
            return dict(status=status, error=error, predictions={}, ground_truth={}, context=dict(context))

        latest = self.predictions.get_latest()
        latest_context = latest.get("context") if isinstance(latest, dict) else None
        if (
            same_analysis_context(latest_context, context)
            and latest.get("status") == "ready"
        ):
            return latest

        stale = find_stale_cache_entry(
            self.state["game"],
            node,
            context["cacheKey"],
            OPPONENT_ANALYSIS_CACHE_FIELD,
            resolve=False,
        )
        if same_analysis_context(latest_context, context):
            if isinstance(stale, dict):
                return self._present_cached(stale, context)
            return latest

        self.request_current(node["snapshot"])
        if isinstance(stale, dict):
            return self._present_cached(stale, context)
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

    def _present_cached(self, cached, context, *, terminal=False):
        context = dict(context)
        source_id = context.get('sourceNodeId') or context['nodeId']
        if self.dependencies.build_analysis_table is not None and (
                source_id != context['nodeId']
                or (context.get('inputMode') == 'full-information') != bool(self.state['visibleHands'])):
            source = self.state['game']['nodes'].get(source_id)
            if source is not None:
                context['sourceTable'] = self.dependencies.build_analysis_table(
                    source['snapshot'], context['seat'], context['inputMode'])
        if isinstance(cached, AnalysisReference):
            result = self.dependencies.read_presenter.read(
                cached, kind='opponent', context=context, terminal=terminal,
                metadata=cache_presentation_metadata(self.state['game'], cached.cache_key, context['cacheKey']))
            return result if result is not None else dict(
                status='loading', predictions={}, ground_truth={}, context={**context, 'dataState': 'reading'})
        result = attach_analysis_context(cached, context)
        result['context']['dataState'] = 'ready'
        if terminal:
            result['status'] = 'terminal'
        return result
