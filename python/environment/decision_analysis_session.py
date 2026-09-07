"""Current-position decision analysis, cache and background-task ownership."""

from __future__ import annotations

import copy
import time
from dataclasses import dataclass
from typing import Any, Callable, MutableMapping, Optional

from action_recommendation_adapter import analyze_action_choices, analyze_discard_choices
from analysis_cache import (
    cache_key_context,
    decision_cache_key,
    find_stale_cache_entry,
    prune_stale_cache_entries,
    register_analysis_source,
)
from service_helpers import (
    build_comparison_result,
    build_reaction_comparison_result,
    build_special_action_comparison_result,
    now_iso,
)


@dataclass
class DecisionAnalysisDependencies:
    play_prefetch_owns: Callable[[str, str], bool]
    auto_analysis_owns: Callable[[str, str], bool]
    build_mjai_stream_bundle: Callable[..., dict[str, Any]]
    build_legal_actions: Callable[..., list[dict[str, Any]]]
    get_node_legal_actions: Callable[..., list[dict[str, Any]]]
    sync_snapshot: Callable[[dict[str, Any]], Any]
    set_timeline_cached: Callable[[str, str, bool], None]
    build_state: Callable[[], dict[str, Any]]
    emit: Callable[[dict[str, Any]], None]


class DecisionAnalysisSession:
    """Own decision-analysis tasks and storage for the active game."""

    def __init__(
        self,
        state: MutableMapping[str, Any],
        state_lock: Any,
        action_gateway: Any,
        engine_management: Any,
        executor: Any,
        dependencies: DecisionAnalysisDependencies,
    ) -> None:
        self.state = state
        self.state_lock = state_lock
        self.action_gateway = action_gateway
        self.engine_management = engine_management
        self.executor = executor
        self.dependencies = dependencies
        self._tasks: dict[tuple[Any, ...], Any] = {}
        self._completed: set[tuple[Any, ...]] = set()

    @staticmethod
    def _task_key(game: Any, node_id: Any, analysis_key: Any) -> tuple[Any, ...]:
        return (
            game.get("gameId") if isinstance(game, dict) else None,
            node_id,
            analysis_key,
        )

    def purge(self, game_id: Any, node_ids: Optional[list[str]] = None) -> None:
        if node_ids is None:
            stale_keys = [
                key for key in self._tasks if key and key[0] == game_id
            ]
            completed_keys = [
                key for key in self._completed if key and key[0] == game_id
            ]
        else:
            node_id_set = set(node_ids)
            stale_keys = [
                key
                for key in self._tasks
                if key and key[0] == game_id and key[1] in node_id_set
            ]
            completed_keys = [
                key
                for key in self._completed
                if key and key[0] == game_id and key[1] in node_id_set
            ]
        for key in stale_keys:
            future = self._tasks.pop(key, None)
            if future is not None:
                try:
                    future.cancel()
                except Exception:  # pragma: no cover - Future cancellation is best effort
                    pass
        self._completed.difference_update(completed_keys)

    def cancel_pending(self) -> None:
        for future in list(self._tasks.values()):
            try:
                future.cancel()
            except Exception:  # pragma: no cover - Future cancellation is best effort
                pass

    def reset(self) -> None:
        self.cancel_pending()
        self._tasks.clear()
        self._completed.clear()

    def cache_key(self, snapshot: dict[str, Any]) -> str:
        return self.cache_key_for(
            int(self.state["controlledSeat"]),
            snapshot,
            None,
        )

    def cache_key_for(
        self,
        seat: int,
        snapshot: dict[str, Any],
        model_path: Optional[str],
    ) -> str:
        phase = snapshot.get("phase")
        if phase == "draw_or_discard":
            phase = "discard"
        return decision_cache_key(
            seat,
            phase,
            self.engine_management.decision_source(model_path),
        )

    def store(
        self,
        game: Any,
        node: Any,
        cache_key: str,
        result: Any,
        *,
        source: Optional[dict[str, Any]] = None,
    ) -> Optional[dict[str, Any]]:
        if (
            not isinstance(game, dict)
            or not isinstance(node, dict)
            or not isinstance(result, dict)
        ):
            return None
        resolved_source = (
            copy.deepcopy(source)
            if isinstance(source, dict)
            else self.engine_management.decision_source()
        )
        resolved_source["displayName"] = self.engine_management.source_display_name(
            "decision"
        )
        expected_source_id = (cache_key_context(cache_key) or {}).get("sourceId")
        if expected_source_id != resolved_source["id"]:
            return None
        register_analysis_source(game, resolved_source, result)
        compact = copy.deepcopy(result)
        compact.pop("engineFingerprint", None)
        compact.pop("hostPostprocessorVersion", None)
        cache = node.setdefault("analysisCache", {})
        prune_stale_cache_entries(cache, cache_key)
        cache[cache_key] = compact
        return cache[cache_key]

    @staticmethod
    def _build_child_comparison(
        parent_node: dict[str, Any],
        child_node: dict[str, Any],
        analysis: dict[str, Any],
        controlled_seat: int,
    ) -> Optional[dict[str, Any]]:
        action = child_node.get("action") or {}
        try:
            actor = int(action.get("actor", -1))
        except (TypeError, ValueError):
            return None
        if actor != controlled_seat:
            return None

        action_type = str(action.get("type") or "")
        variant = action.get("variant")
        parent_phase = str((parent_node.get("snapshot") or {}).get("phase") or "")
        if action_type == "dahai":
            tile = str(action.get("pai") or "")
            return (
                build_comparison_result(
                    analysis,
                    tile,
                    actor,
                    action.get("tsumogiri"),
                )
                if tile
                else None
            )
        if parent_phase in ("draw_or_discard", "discard", "reach_declaration"):
            return build_special_action_comparison_result(
                analysis,
                action_type,
                actor,
                variant,
            )
        if parent_phase in ("reaction_window", "kan_reaction_window"):
            return build_reaction_comparison_result(
                analysis,
                action_type,
                actor,
                variant,
                consumed=action.get("consumed"),
            )
        return None

    def update_child_comparisons(
        self,
        game: dict[str, Any],
        parent_node: dict[str, Any],
        analysis: dict[str, Any],
        controlled_seat: int,
        *,
        only_missing: bool = False,
    ) -> list[dict[str, Any]]:
        updates = []
        for child_id in parent_node.get("children", []):
            child_node = game.get("nodes", {}).get(child_id)
            if not child_node or (only_missing and child_node.get("comparison")):
                continue
            try:
                comparison = self._build_child_comparison(
                    parent_node,
                    child_node,
                    analysis,
                    controlled_seat,
                )
            except Exception:  # pylint: disable=broad-except
                comparison = None
            if comparison is None or comparison == child_node.get("comparison"):
                continue
            child_node["comparison"] = copy.deepcopy(comparison)
            updates.append(
                {"id": child_id, "comparison": copy.deepcopy(comparison)}
            )
        return updates

    def backfill_child_comparisons(
        self,
        game: dict[str, Any],
    ) -> list[dict[str, Any]]:
        controlled_seat = int(self.state["controlledSeat"])
        updates = []
        for parent_node in game.get("nodes", {}).values():
            snapshot = parent_node.get("snapshot") or {}
            phase = str(snapshot.get("phase") or "")
            if phase == "draw_or_discard":
                phase = "discard"
            analysis_key = decision_cache_key(
                controlled_seat,
                phase,
                self.engine_management.decision_source(),
            )
            analysis = (parent_node.get("analysisCache") or {}).get(analysis_key)
            if not isinstance(analysis, dict) or analysis.get("error"):
                continue
            updates.extend(
                self.update_child_comparisons(
                    game,
                    parent_node,
                    analysis,
                    controlled_seat,
                    only_missing=True,
                )
            )
        return updates

    def submit_background(
        self,
        current_node: dict[str, Any],
        snapshot: dict[str, Any],
    ) -> None:
        if not self.state.get("decisionRecommendationsEnabled", True):
            return
        if snapshot.get("phase") not in (
            "discard",
            "reach_declaration",
            "reaction_window",
            "kan_reaction_window",
        ):
            return

        analysis_key = self.cache_key(snapshot)
        if analysis_key in current_node.get("analysisCache", {}):
            return

        game = self.state.get("game")
        node_id = current_node.get("id")
        game_id = game.get("gameId") if isinstance(game, dict) else None
        if self.dependencies.play_prefetch_owns(node_id, analysis_key):
            return
        if self.dependencies.auto_analysis_owns("decision", node_id):
            return
        task_key = self._task_key(game, node_id, analysis_key)
        if task_key in self._tasks or task_key in self._completed:
            return

        seat = int(self.state["controlledSeat"])
        model_path = self.engine_management.action_weight_path()
        stream_bundle = self.dependencies.build_mjai_stream_bundle(
            game,
            node_id,
            seat,
        )
        submitted_at = time.perf_counter()
        cache_epoch = self.engine_management.decision_cache_epoch
        legal_actions = self.dependencies.build_legal_actions(
            snapshot,
            controlled_seat=seat,
        )

        def task() -> dict[str, Any]:
            started_at = time.perf_counter()
            if snapshot["phase"] in ("discard", "reach_declaration"):
                analysis = analyze_discard_choices(
                    self.action_gateway,
                    snapshot,
                    seat,
                    model_path,
                    mjai_events=stream_bundle["events"],
                    mjai_prefix_hashes=stream_bundle["prefixHashes"],
                    mjai_events_hash=stream_bundle["eventHash"],
                    legal_actions=legal_actions,
                    position_id=node_id,
                )
            else:
                analysis = analyze_action_choices(
                    self.action_gateway,
                    snapshot,
                    seat,
                    model_path,
                    mjai_events=stream_bundle["events"],
                    mjai_prefix_hashes=stream_bundle["prefixHashes"],
                    mjai_events_hash=stream_bundle["eventHash"],
                    legal_actions=legal_actions,
                    position_id=node_id,
                )
            return {
                "analysis": analysis,
                "queueWaitMs": round((started_at - submitted_at) * 1000, 3),
                "taskMs": round((time.perf_counter() - started_at) * 1000, 3),
            }

        def complete(future: Any) -> None:
            with self.state_lock:
                should_mark_completed = False
                tree_updates = []
                try:
                    wrapped = future.result()
                    if (
                        cache_epoch != self.engine_management.decision_cache_epoch
                        or self.state.get("game") is not game
                        or game.get("nodes", {}).get(node_id) is not current_node
                    ):
                        return
                    result = (
                        wrapped.get("analysis")
                        if isinstance(wrapped, dict)
                        else wrapped
                    )
                    if isinstance(result, dict) and not result.get("error"):
                        stored = self.store(
                            game,
                            current_node,
                            analysis_key,
                            result,
                        )
                        if stored is not None:
                            self.dependencies.set_timeline_cached(
                                "decision", node_id, True
                            )
                            tree_updates = self.update_child_comparisons(
                                game,
                                current_node,
                                result,
                                seat,
                            )
                            should_mark_completed = True
                    if self.state.get("decisionRecommendationsEnabled", True):
                        self.dependencies.emit(
                            {
                                "type": "analysis_ready",
                                "cacheEpoch": cache_epoch,
                                "nodeId": node_id,
                                "gameId": game_id,
                                "analysisKey": analysis_key,
                                "analysis": result,
                                "treeComparisons": tree_updates,
                                "treeRevision": int(game.get("treeRevision", 0)),
                                "state": self.dependencies.build_state(),
                                "timestamp": now_iso(),
                            }
                        )
                except Exception:  # pylint: disable=broad-except
                    pass
                finally:
                    if self._tasks.get(task_key) is future:
                        self._tasks.pop(task_key, None)
                    if should_mark_completed:
                        self._completed.add(task_key)
                        self.dependencies.emit(
                            {
                                "type": "record_changed",
                                "gameId": game_id,
                                "change": "decision_analysis_cache",
                                "timestamp": now_iso(),
                            }
                        )

        future = self.executor.submit(task)
        self._tasks[task_key] = future
        future.add_done_callback(complete)

    def get_or_schedule(
        self,
        current_node: dict[str, Any],
        snapshot: dict[str, Any],
        legal_actions: list[dict[str, Any]],
    ) -> Optional[dict[str, Any]]:
        if not self.state.get("decisionRecommendationsEnabled", True):
            return None
        if not legal_actions:
            return None

        analysis_key = self.cache_key(snapshot)
        if analysis_key in current_node.get("analysisCache", {}):
            return copy.deepcopy(current_node["analysisCache"][analysis_key])
        if not self.action_gateway.accepts_requests():
            return find_stale_cache_entry(
                self.state.get("game"),
                current_node,
                analysis_key,
                "analysisCache",
            )
        if snapshot.get("phase") not in (
            "discard",
            "reach_declaration",
            "reaction_window",
            "kan_reaction_window",
        ):
            return None
        self.submit_background(current_node, snapshot)
        return find_stale_cache_entry(
            self.state.get("game"),
            current_node,
            analysis_key,
            "analysisCache",
        )

    def resolve_current(
        self,
        current_node: dict[str, Any],
        snapshot: dict[str, Any],
        legal_actions: list[dict[str, Any]],
    ) -> Optional[dict[str, Any]]:
        if not self.state.get("decisionRecommendationsEnabled", True):
            return None
        if not legal_actions:
            return None

        analysis_key = self.cache_key(snapshot)
        stream_bundle = self.dependencies.build_mjai_stream_bundle(
            self.state["game"],
            current_node["id"],
            self.state["controlledSeat"],
        )
        phase = snapshot.get("phase")
        if phase in ("draw_or_discard", "discard", "reach_declaration"):
            resolver = lambda: analyze_discard_choices(  # noqa: E731
                self.action_gateway,
                snapshot,
                self.state["controlledSeat"],
                self.engine_management.action_weight_path(),
                mjai_events=stream_bundle["events"],
                mjai_prefix_hashes=stream_bundle["prefixHashes"],
                mjai_events_hash=stream_bundle["eventHash"],
                legal_actions=legal_actions,
                position_id=current_node.get("id", ""),
            )
            empty = {
                "error": None,
                "model": "decision-engine",
                "seat": self.state["controlledSeat"],
                "discardEntries": [],
            }
        elif phase in ("reaction_window", "kan_reaction_window"):
            resolver = lambda: analyze_action_choices(  # noqa: E731
                self.action_gateway,
                snapshot,
                self.state["controlledSeat"],
                self.engine_management.action_weight_path(),
                mjai_events=stream_bundle["events"],
                mjai_prefix_hashes=stream_bundle["prefixHashes"],
                mjai_events_hash=stream_bundle["eventHash"],
                legal_actions=legal_actions,
                position_id=current_node.get("id", ""),
            )
            empty = {
                "error": None,
                "mode": "reaction",
                "model": "decision-engine",
                "seat": self.state["controlledSeat"],
                "reactionEntries": [],
                "bestAction": None,
            }
        else:
            return None

        try:
            if analysis_key not in current_node["analysisCache"]:
                resolved = resolver()
                cached_analysis = self.store(
                    self.state["game"],
                    current_node,
                    analysis_key,
                    resolved,
                )
                self.dependencies.set_timeline_cached(
                    "decision",
                    current_node.get("id"),
                    isinstance(cached_analysis, dict)
                    and not cached_analysis.get("error"),
                )
            cached = current_node.get("analysisCache", {}).get(analysis_key)
            return copy.deepcopy(cached) if isinstance(cached, dict) else empty
        except Exception as error:  # pylint: disable=broad-except
            empty["error"] = str(error)
            return empty

    def ensure_cached(
        self,
        current_node: dict[str, Any],
        snapshot: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        if not self.state.get("decisionRecommendationsEnabled", True):
            return None
        self.dependencies.sync_snapshot(snapshot)
        if snapshot.get("phase") not in (
            "draw_or_discard",
            "discard",
            "reach_declaration",
            "reaction_window",
            "kan_reaction_window",
        ):
            return None

        analysis_key = self.cache_key(snapshot)
        if analysis_key in current_node["analysisCache"]:
            return current_node["analysisCache"][analysis_key]
        if not self.action_gateway.accepts_requests():
            return None

        task_key = self._task_key(
            self.state.get("game"),
            current_node.get("id"),
            analysis_key,
        )
        bg_future = self._tasks.get(task_key)
        if bg_future is not None:
            if bg_future.done():
                try:
                    result = bg_future.result()
                    self._tasks.pop(task_key, None)
                    if isinstance(result, dict) and not result.get("error"):
                        stored = self.store(
                            self.state["game"],
                            current_node,
                            analysis_key,
                            result,
                        )
                        if stored is not None:
                            self.dependencies.set_timeline_cached(
                                "decision", current_node.get("id"), True
                            )
                            return stored
                except Exception:  # pylint: disable=broad-except
                    self._tasks.pop(task_key, None)
            return None

        if analysis_key in current_node["analysisCache"]:
            return current_node["analysisCache"][analysis_key]
        legal_actions = self.dependencies.get_node_legal_actions(
            self.state["game"],
            current_node["id"],
        )
        if not legal_actions:
            return None
        analysis = self.resolve_current(current_node, snapshot, legal_actions)
        if analysis is None or analysis.get("error"):
            return None
        stored = self.store(
            self.state["game"],
            current_node,
            analysis_key,
            analysis,
        )
        if stored is not None:
            self.dependencies.set_timeline_cached(
                "decision", current_node.get("id"), True
            )
        return stored
