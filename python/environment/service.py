import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import auto_analysis_session
import analysis_commands
import command_transport
import decision_analysis_session
import engine_management
import environment_view
import game_flow
import game_setup
import game_tree
import game_tree_coordinator
import gameplay_commands
import legal_action_provider
import legal_actions
import opponent_analysis_session
import play_prefetch_session
import reaction_decision_history
import record_commands
import record_workspace_commands
import record_session
import review_session
import round_actions
import round_progression
import round_wall_replacement
import runtime_metrics
import snapshot_state
import stateful_command_dispatcher
import view_control_commands
import wall_reconstruction
from action_recommendation_adapter import (
    choose_ai_action,
    get_and_reset_ai_thinking_time_s,
    get_latest_action_recommendation_debug,
    set_thinking_time_bounds,
)
from action_recommendation_gateway import ActionRecommendationGateway
from engine_runtime import EngineRuntimeRegistry
from mjai_stream_cache import MjaiStreamCache
from opponent_prediction_coordinator import OpponentPredictionCoordinator
from opponent_prediction_gateway import get_latest_opponent_prediction_mjai
from service_debug import run_debug_scenario
from service_helpers import actor_just_drew, now_iso
from rule_kernel import (
    can_ankan,
    can_declare_riichi,
    can_declare_tsumo,
    build_player_state,
    get_ankan_candidates,
)

def get_project_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


STATE = {
    "mode": "play",
    "controlledSeat": 0,
    "pendingSeatSwitch": None,
    "visibleHands": False,
    "decisionRecommendationsEnabled": True,
    "opponentAnalysisEnabled": False,
    "gameLoaded": False,
    "game": None,
    "nextGameId": 1,
}
PROJECT_ROOT = get_project_root()
PORTABLE_ROOT = Path(os.environ.get("MJAI_TRAINER_PORTABLE_DIR") or PROJECT_ROOT).resolve()
ACTION_RECOMMENDATIONS = ActionRecommendationGateway()
OPPONENT_PREDICTIONS = OpponentPredictionCoordinator()
ENGINE_RUNTIME_REGISTRY = EngineRuntimeRegistry()
_BG_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_ENGINE_PREWARM_EXECUTOR = ThreadPoolExecutor(max_workers=2)
_COMMAND_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_STATUS_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_METRICS_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_ENGINE_INSPECTION_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_ENGINE_RELOAD_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_EMIT_LOCK = threading.Lock()
_STATE_LOCK = threading.RLock()
MJAI_STREAMS = MjaiStreamCache(snapshot_state.sync)
DEBUG_FLOW = os.environ.get("MJAI_FLOW_DEBUG", "").lower() in ("1", "true", "yes", "on")
def debug_flow(message):
    if DEBUG_FLOW:
        print(message, file=sys.stderr)


def emit(payload):
    with _EMIT_LOCK:
        sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
        sys.stdout.flush()


def _invalidate_engine_analysis(reason):
    with _STATE_LOCK:
        AUTO_ANALYSIS.cancel(reason)
        PLAY_PREFETCH.cancel()
        active_game = STATE.get("game")
        DECISION_ANALYSIS.purge(
            active_game.get("gameId") if isinstance(active_game, dict) else None
        )
        OPPONENT_PREDICTIONS.cancel_all()
        AUTO_ANALYSIS.invalidate_timeline()


def _prepare_for_engine_unload():
    with _STATE_LOCK:
        AUTO_ANALYSIS.cancel("分析引擎已卸载")
        PLAY_PREFETCH.cancel()
        active_game = STATE.get("game")
        DECISION_ANALYSIS.purge(
            active_game.get("gameId") if isinstance(active_game, dict) else None
        )


ENGINE_MANAGEMENT = engine_management.EngineManagement(
    STATE,
    project_root=PROJECT_ROOT,
    portable_root=PORTABLE_ROOT,
    resource_root=Path(__file__).resolve().parents[2],
    action_gateway=ACTION_RECOMMENDATIONS,
    opponent_predictions=OPPONENT_PREDICTIONS,
    runtime_registry=ENGINE_RUNTIME_REGISTRY,
    prewarm_executor=_ENGINE_PREWARM_EXECUTOR,
    emit=emit,
    lifecycle=engine_management.EngineLifecycleCallbacks(
        invalidate_analysis=_invalidate_engine_analysis,
        prepare_for_unload=_prepare_for_engine_unload,
        build_state=lambda: VIEW_BUILDER.build_state_payload(
            consume_thinking_time=False
        ),
    ),
)


OPPONENT_ANALYSIS = opponent_analysis_session.OpponentAnalysisSession(
    STATE,
    _STATE_LOCK,
    OPPONENT_PREDICTIONS,
    ENGINE_MANAGEMENT,
    opponent_analysis_session.OpponentAnalysisDependencies(
        build_mjai_stream_bundle=MJAI_STREAMS.get_bundle,
        play_prefetch_owns=lambda node_id: PLAY_PREFETCH.owns_opponent(node_id),
        auto_analysis_owns=lambda kind, node_id: AUTO_ANALYSIS.owns_item(kind, node_id),
        set_timeline_cached=lambda kind, node_id, cached: AUTO_ANALYSIS.set_timeline_cached(
            kind, node_id, cached
        ),
        get_auto_analysis_status=lambda **kwargs: AUTO_ANALYSIS.status(**kwargs),
        emit=emit,
    ),
)


DECISION_ANALYSIS = decision_analysis_session.DecisionAnalysisSession(
    STATE,
    _STATE_LOCK,
    ACTION_RECOMMENDATIONS,
    ENGINE_MANAGEMENT,
    _BG_EXECUTOR,
    decision_analysis_session.DecisionAnalysisDependencies(
        play_prefetch_owns=lambda node_id, analysis_key: PLAY_PREFETCH.owns_decision(
            node_id, analysis_key
        ),
        auto_analysis_owns=lambda kind, node_id: AUTO_ANALYSIS.owns_item(kind, node_id),
        build_mjai_stream_bundle=MJAI_STREAMS.get_bundle,
        build_legal_actions=lambda *args, **kwargs: build_legal_actions(
            *args, **kwargs
        ),
        get_node_legal_actions=lambda *args, **kwargs: get_node_legal_actions(
            *args, **kwargs
        ),
        sync_snapshot=lambda snapshot: sync_snapshot_state(snapshot),
        set_timeline_cached=lambda kind, node_id, cached: AUTO_ANALYSIS.set_timeline_cached(
            kind, node_id, cached
        ),
        build_state=lambda: VIEW_BUILDER.build_state_payload(),
        emit=emit,
    ),
)


AUTO_ANALYSIS = auto_analysis_session.AutoAnalysisSession(
    STATE,
    _STATE_LOCK,
    ACTION_RECOMMENDATIONS,
    OPPONENT_PREDICTIONS,
    ENGINE_MANAGEMENT,
    DECISION_ANALYSIS,
    OPPONENT_ANALYSIS,
    _BG_EXECUTOR,
    auto_analysis_session.AutoAnalysisDependencies(
        play_prefetch_active=lambda: (
            PLAY_PREFETCH.has_active_draft()
        ),
        build_mjai_stream_bundle=MJAI_STREAMS.get_bundle,
        get_node_legal_actions=lambda *args, **kwargs: get_node_legal_actions(
            *args, **kwargs
        ),
        build_legal_actions=lambda *args, **kwargs: build_legal_actions(
            *args, **kwargs
        ),
        sync_snapshot=lambda snapshot: sync_snapshot_state(snapshot),
        ensure_game_loaded=lambda: ensure_game_loaded(),
        build_state=lambda *args, **kwargs: VIEW_BUILDER.build_state_payload(
            *args, **kwargs
        ),
        emit=emit,
    ),
)


ROUND_PROGRESSION = round_progression.RoundProgression(
    round_progression.RoundProgressionDependencies(
        create_initial_snapshot=game_setup.create_initial_snapshot,
        create_node=lambda *args, **kwargs: TREE_EDITS.create_node(*args, **kwargs),
        attach_mainline=lambda *args, **kwargs: TREE_EDITS.attach_mainline(*args, **kwargs),
        promote_mainline=lambda *args, **kwargs: TREE_EDITS.promote_path_to_mainline(
            *args, **kwargs
        ),
    )
)


ROUND_ACTIONS = round_actions.RoundActions(
    ROUND_PROGRESSION,
    round_actions.RoundActionDependencies(
        controlled_seat=lambda: int(STATE["controlledSeat"]),
        action_weight_path=ENGINE_MANAGEMENT.action_weight_path,
        choose_ai_action=lambda *args, **kwargs: choose_ai_action_for_snapshot(
            *args, **kwargs
        ),
    ),
)


GAME_FLOW = game_flow.GameFlow(
    ROUND_ACTIONS,
    ROUND_PROGRESSION,
    game_flow.GameFlowDependencies(
        controlled_seat=lambda: int(STATE["controlledSeat"]),
        action_weight_path=ENGINE_MANAGEMENT.action_weight_path,
        choose_ai_action=lambda *args, **kwargs: choose_ai_action_for_current_node(
            *args, **kwargs
        ),
        build_legal_actions=lambda *args, **kwargs: build_legal_actions(
            *args, **kwargs
        ),
        controlled_seat_has_pending_action=lambda snapshot: controlled_seat_has_pending_action(
            snapshot
        ),
        apply_pending_seat_switch=lambda snapshot: VIEW_CONTROL_COMMANDS.apply_pending_seat_switch(
            snapshot
        ),
        materialize_automatic_reaction_decisions=lambda *args, **kwargs: REACTION_DECISIONS.materialize_automatic(
            *args, **kwargs
        ),
        create_node=lambda *args, **kwargs: TREE_EDITS.create_node(*args, **kwargs),
        attach_mainline=lambda *args, **kwargs: TREE_EDITS.attach_mainline(*args, **kwargs),
        promote_mainline=lambda *args, **kwargs: TREE_EDITS.promote_path_to_mainline(
            *args, **kwargs
        ),
        debug=debug_flow,
    ),
)


REVIEW_SESSION = review_session.ReviewSession(
    STATE,
    ROUND_ACTIONS,
    ROUND_PROGRESSION,
    DECISION_ANALYSIS,
    ENGINE_MANAGEMENT,
    GAME_FLOW,
    review_session.ReviewSessionDependencies(
        get_active_reaction_window=reaction_decision_history.get_active_reaction_window,
        build_local_reaction_actions=lambda *args, **kwargs: _build_local_reaction_actions(
            *args, **kwargs
        ),
        build_legal_actions=lambda *args, **kwargs: build_legal_actions(
            *args, **kwargs
        ),
        refresh_reused_child=lambda *args, **kwargs: TREE_EDITS.refresh_reused_imported_child(
            *args, **kwargs
        ),
        create_node=lambda *args, **kwargs: TREE_EDITS.create_node(*args, **kwargs),
        attach_mainline=lambda *args, **kwargs: TREE_EDITS.attach_mainline(*args, **kwargs),
        promote_mainline=lambda *args, **kwargs: TREE_EDITS.promote_path_to_mainline(
            *args, **kwargs
        ),
        replace_pending_review_main_child=lambda *args, **kwargs: TREE_EDITS.replace_pending_review_main_child(
            *args, **kwargs
        ),
    ),
)


PLAY_PREFETCH = play_prefetch_session.PlayPrefetchSession(
    STATE,
    _STATE_LOCK,
    OPPONENT_PREDICTIONS,
    ENGINE_MANAGEMENT,
    OPPONENT_ANALYSIS,
    DECISION_ANALYSIS,
    AUTO_ANALYSIS,
    GAME_FLOW,
    play_prefetch_session.PlayPrefetchDependencies(
        build_mjai_stream_bundle=MJAI_STREAMS.get_bundle,
        build_legal_actions=lambda *args, **kwargs: build_legal_actions(
            *args, **kwargs
        ),
        build_state=lambda *args, **kwargs: VIEW_BUILDER.build_state_payload(
            *args, **kwargs
        ),
        is_read_only_game=lambda game: is_read_only_game(game),
        find_existing_child=lambda *args, **kwargs: REVIEW_SESSION.find_existing_child(
            *args, **kwargs
        ),
        create_node=lambda *args, **kwargs: TREE_EDITS.create_node(*args, **kwargs),
        attach_mainline=lambda *args, **kwargs: TREE_EDITS.attach_mainline(*args, **kwargs),
        promote_mainline=lambda *args, **kwargs: TREE_EDITS.promote_path_to_mainline(
            *args, **kwargs
        ),
        emit=emit,
    ),
)


def sync_snapshot_state(snapshot):
    return snapshot_state.sync(snapshot)


def persist_snapshot_state(snapshot):
    return snapshot_state.persist(snapshot)


def create_empty_game(seed):
    game_index = int(STATE["nextGameId"])
    STATE["nextGameId"] = game_index + 1
    game_id = f"game_{game_index:04d}"
    match_state = game_setup.create_match_state(
        seed,
        f"match_{game_index:04d}",
    )
    return game_setup.create_empty_game(
        seed,
        game_id,
        match_state,
        created_at=now_iso(),
    )


def ensure_game_loaded():
    if not STATE["gameLoaded"] or not STATE["game"]:
        raise ValueError("No active game is loaded.")


def is_read_only_game(game=None):
    active_game = game if game is not None else STATE.get("game")
    metadata = active_game.get("metadata") if isinstance(active_game, dict) else None
    return bool(isinstance(metadata, dict) and metadata.get("readOnly"))


def ensure_writable_game():
    ensure_game_loaded()
    if is_read_only_game():
        raise ValueError("This replay has no complete wall and is read-only.")


def ensure_play_mode():
    ensure_writable_game()
    if STATE.get("mode") != "play":
        raise ValueError("Game actions are only available in play mode.")


def get_current_snapshot():
    ensure_game_loaded()
    game = STATE["game"]
    return game["nodes"][game["currentNodeId"]]["snapshot"]


def reset_runtime_for_game_change():
    PLAY_PREFETCH.cancel()
    AUTO_ANALYSIS.reset_for_game_change()
    ENGINE_MANAGEMENT.advance_cache_epochs()
    DECISION_ANALYSIS.reset()
    MJAI_STREAMS.clear()
    LEGAL_ACTIONS.clear_cache()
    OPPONENT_PREDICTIONS.cancel_all()
    ACTION_RECOMMENDATIONS.reset_session()


def choose_ai_action_for_current_node(snapshot, seat, model_path):
    prefetch_game = PLAY_PREFETCH.active_draft()
    game = prefetch_game or STATE.get("game")
    legal_actions = build_legal_actions(snapshot, controlled_seat=seat)
    if not game or not STATE.get("gameLoaded"):
        return choose_ai_action(
            ACTION_RECOMMENDATIONS,
            snapshot,
            seat,
            model_path,
            legal_actions=legal_actions,
        )
    current_node_id = game.get("currentNodeId")
    if not current_node_id:
        return choose_ai_action(
            ACTION_RECOMMENDATIONS,
            snapshot,
            seat,
            model_path,
            legal_actions=legal_actions,
        )
    bundle = MJAI_STREAMS.get_bundle(game, current_node_id, seat)
    return choose_ai_action(
        ACTION_RECOMMENDATIONS,
        snapshot,
        seat,
        model_path,
        mjai_events=bundle["events"],
        mjai_prefix_hashes=bundle["prefixHashes"],
        mjai_events_hash=bundle["eventHash"],
        accumulate_thinking=prefetch_game is None,
        legal_actions=legal_actions,
        position_id=current_node_id,
    )


def choose_ai_action_for_snapshot(snapshot, seat, model_path, *, accumulate_thinking=True):
    bundle = MJAI_STREAMS.build_uncached_bundle(snapshot, seat)
    return choose_ai_action(
        ACTION_RECOMMENDATIONS,
        snapshot,
        seat,
        model_path,
        mjai_events=bundle["events"],
        mjai_prefix_hashes=bundle["prefixHashes"],
        mjai_events_hash=bundle["eventHash"],
        accumulate_thinking=accumulate_thinking,
        legal_actions=build_legal_actions(snapshot, controlled_seat=seat),
    )


def build_legal_actions(snapshot, controlled_seat=None):
    if controlled_seat is None:
        controlled_seat = STATE["controlledSeat"]
    return legal_actions.build_legal_actions(
        snapshot,
        legal_actions.normalize_seat(controlled_seat),
        build_player_state=build_player_state,
        can_declare_tsumo=can_declare_tsumo,
        can_declare_riichi=can_declare_riichi,
        can_declare_kyuushu_kyuuhai=ROUND_PROGRESSION.can_declare_kyuushu_kyuuhai,
        get_ankan_candidates=get_ankan_candidates,
        get_legal_kan_actions=lambda snapshot, actor: legal_actions.get_legal_kan_actions(
            snapshot, actor
        ),
        build_local_reaction_actions=_build_local_reaction_actions,
        debug=debug_flow,
    )


def get_node_legal_actions(game, node_id, controlled_seat=None):
    return LEGAL_ACTIONS.for_node(game, node_id, controlled_seat)


def action_is_meaningful_decision(parent_snapshot, action):
    if not isinstance(parent_snapshot, dict) or not isinstance(action, dict):
        return False
    try:
        actor = legal_actions.normalize_seat(action.get("actor"))
        return len(build_legal_actions(parent_snapshot, controlled_seat=actor)) > 1
    except (KeyError, TypeError, ValueError):
        return False


def controlled_seat_has_pending_action(snapshot):
    return len(build_legal_actions(snapshot)) > 0


LEGAL_ACTIONS = legal_action_provider.LegalActionProvider(
    build_actions=lambda *args, **kwargs: build_legal_actions(*args, **kwargs),
    controlled_seat=lambda: STATE["controlledSeat"],
    research_mode=lambda: STATE.get("mode") == "research",
    normalize_seat=legal_actions.normalize_seat,
)


TREE_EDITS = game_tree_coordinator.GameTreeCoordinator(
    STATE,
    game_tree_coordinator.GameTreeDependencies(
        sync_snapshot=sync_snapshot_state,
        is_meaningful_decision=action_is_meaningful_decision,
        active_draft=lambda: PLAY_PREFETCH.active_draft(),
        invalidate_analysis_timeline=lambda: AUTO_ANALYSIS.invalidate_timeline(),
    ),
)


ROUND_WALL_REPLACEMENT = round_wall_replacement.RoundWallReplacement(
    STATE,
    round_wall_replacement.RoundWallReplacementDependencies(
        ensure_game_loaded=ensure_game_loaded,
        validate_full_wall=game_setup.validate_full_wall_tiles,
        create_initial_snapshot=game_setup.create_initial_snapshot,
        resolve_round_root=game_tree.resolve_round_root_id,
        collect_subtree_ids=game_tree.collect_subtree_ids,
        purge_decision_analysis=DECISION_ANALYSIS.purge,
        invalidate_analysis_timeline=AUTO_ANALYSIS.invalidate_timeline,
        promote_mainline=TREE_EDITS.promote_path_to_mainline,
        purge_mjai_cache=MJAI_STREAMS.purge_game,
    ),
)


REACTION_DECISIONS = reaction_decision_history.ReactionDecisionHistory(
    reaction_decision_history.ReactionDecisionDependencies(
        normalize_seat=legal_actions.normalize_seat,
        build_legal_actions=build_legal_actions,
        create_node=TREE_EDITS.create_node,
        attach_mainline=TREE_EDITS.attach_mainline,
        promote_mainline=TREE_EDITS.promote_path_to_mainline,
    )
)

VIEW_BUILDER = environment_view.EnvironmentView(
    STATE,
    environment_view.EnvironmentViewDependencies(
        sync_snapshot=sync_snapshot_state,
        is_read_only_game=is_read_only_game,
        actor_just_drew=actor_just_drew,
        can_declare_tsumo=can_declare_tsumo,
        can_ankan=can_ankan,
        get_node_legal_actions=get_node_legal_actions,
        resolve_round_root=game_tree.resolve_round_root_id,
        decision_analysis=DECISION_ANALYSIS,
        opponent_analysis=OPPONENT_ANALYSIS,
        action_recommendations=ACTION_RECOMMENDATIONS,
        opponent_predictions=OPPONENT_PREDICTIONS,
        engine_management=ENGINE_MANAGEMENT,
        auto_analysis=AUTO_ANALYSIS,
        consume_thinking_time=get_and_reset_ai_thinking_time_s,
        now_iso=now_iso,
    ),
)


def _build_local_reaction_actions(snapshot, actor):
    return legal_actions._build_local_reaction_actions(
        snapshot,
        actor,
        can_resolve_hora_reaction=ROUND_ACTIONS.can_resolve_hora_reaction,
    )


def _prewarm_record_action_engine(seat):
    _BG_EXECUTOR.submit(
        ACTION_RECOMMENDATIONS.prewarm,
        seat,
        ENGINE_MANAGEMENT.action_weight_path(),
    )


RECORD_SESSION = record_session.RecordSession(
    STATE,
    record_session.RecordSessionDependencies(
        reset_runtime=reset_runtime_for_game_change,
        create_empty_game=create_empty_game,
        advance_to_next_user_turn=GAME_FLOW.advance,
        prewarm_action_engine=_prewarm_record_action_engine,
        repair_reaction_decisions=REACTION_DECISIONS.repair,
        backfill_child_comparisons=DECISION_ANALYSIS.backfill_child_comparisons,
        update_child_comparisons=DECISION_ANALYSIS.update_child_comparisons,
        current_snapshot=get_current_snapshot,
        request_opponent_analysis=OPPONENT_ANALYSIS.request_current,
        purge_mjai_cache=MJAI_STREAMS.purge_game,
        invalidate_auto_timeline=AUTO_ANALYSIS.invalidate_timeline,
    ),
)


RECORD_COMMANDS = record_commands.RecordCommands(
    STATE,
    record_commands.RecordCommandDependencies(
        ensure_loaded=ensure_game_loaded,
        ensure_writable=ensure_writable_game,
        round_root_for_node=game_tree.resolve_round_root_id,
        collect_subtree_ids=game_tree.collect_subtree_ids,
        cancel_play_prefetch=PLAY_PREFETCH.cancel,
        cancel_auto_analysis=AUTO_ANALYSIS.cancel,
        schedule_auto_reprioritization=AUTO_ANALYSIS.schedule_reprioritization,
        purge_background_analysis=DECISION_ANALYSIS.purge,
        purge_mjai_cache=MJAI_STREAMS.purge_game,
        sync_snapshot=sync_snapshot_state,
        request_opponent_analysis=OPPONENT_ANALYSIS.request_current,
        promote_mainline=TREE_EDITS.promote_path_to_mainline,
        invalidate_auto_timeline=AUTO_ANALYSIS.invalidate_timeline,
    ),
)

RECORD_WORKSPACE_COMMANDS = record_workspace_commands.RecordWorkspaceCommands(
    STATE,
    record_session=RECORD_SESSION,
    record_commands=RECORD_COMMANDS,
    play_prefetch=PLAY_PREFETCH,
    view_builder=VIEW_BUILDER,
    ensure_loaded=ensure_game_loaded,
    ensure_writable=ensure_writable_game,
    get_wall_view=wall_reconstruction.build_wall_view,
    reset_round_wall=ROUND_WALL_REPLACEMENT.replace,
    now_iso=now_iso,
)

GAMEPLAY_COMMANDS = gameplay_commands.GameplayCommands(
    STATE,
    ensure_play_mode=ensure_play_mode,
    get_current_snapshot=get_current_snapshot,
    play_prefetch=PLAY_PREFETCH,
    opponent_analysis=OPPONENT_ANALYSIS,
    review_session=REVIEW_SESSION,
    view_builder=VIEW_BUILDER,
)

VIEW_CONTROL_COMMANDS = view_control_commands.ViewControlCommands(
    STATE,
    auto_analysis=AUTO_ANALYSIS,
    play_prefetch=PLAY_PREFETCH,
    opponent_analysis=OPPONENT_ANALYSIS,
    opponent_predictions=OPPONENT_PREDICTIONS,
    decision_analysis=DECISION_ANALYSIS,
    review_session=REVIEW_SESSION,
    game_flow=GAME_FLOW,
    view_builder=VIEW_BUILDER,
    ensure_loaded=ensure_game_loaded,
    is_read_only=is_read_only_game,
    normalize_mode=record_session.RecordSession.normalize_mode,
    normalize_seat=record_session.RecordSession.normalize_seat,
    get_current_snapshot=get_current_snapshot,
)

ANALYSIS_COMMANDS = analysis_commands.AnalysisCommands(
    state=STATE,
    auto_analysis=AUTO_ANALYSIS,
    play_prefetch=PLAY_PREFETCH,
    decision_analysis=DECISION_ANALYSIS,
    opponent_predictions=OPPONENT_PREDICTIONS,
    engine_management=ENGINE_MANAGEMENT,
    opponent_analysis=OPPONENT_ANALYSIS,
    view_builder=VIEW_BUILDER,
    ensure_game_loaded=ensure_game_loaded,
    get_action_debug=get_latest_action_recommendation_debug,
    get_opponent_debug=get_latest_opponent_prediction_mjai,
    now_iso=now_iso,
)


def _configure_command_thinking_time():
    training = ENGINE_MANAGEMENT.training_config()
    set_thinking_time_bounds(
        float(training.get("thinkingTimeMinS", 0.25)),
        float(training.get("thinkingTimeMaxS", 1.0)),
    )


STATEFUL_COMMANDS = stateful_command_dispatcher.StatefulCommandDispatcher(
    state_lock=_STATE_LOCK,
    configure_thinking_time=_configure_command_thinking_time,
    run_debug_scenario=lambda command: run_debug_scenario(
        command,
        sys.modules[__name__],
    ),
    view_builder=VIEW_BUILDER,
    analysis_commands=ANALYSIS_COMMANDS,
    record_commands=RECORD_WORKSPACE_COMMANDS,
    view_control_commands=VIEW_CONTROL_COMMANDS,
    gameplay_commands=GAMEPLAY_COMMANDS,
)


COMMAND_TRANSPORT = command_transport.CommandTransport(
    state_lock=_STATE_LOCK,
    view_builder=VIEW_BUILDER,
    engine_management=ENGINE_MANAGEMENT,
    collect_runtime_metrics=runtime_metrics.collect_runtime_memory_metrics,
    dispatch_stateful=STATEFUL_COMMANDS.dispatch,
    emit=emit,
    now_iso=now_iso,
)


def main():
    ENGINE_MANAGEMENT.apply_runtime_config(ENGINE_MANAGEMENT.load_project_config())
    emit(
        {
            "type": "service_ready",
            "service": "environment",
            "timestamp": now_iso(),
        }
    )

    for line in sys.stdin:
        message = line.strip()
        if not message:
            continue

        try:
            data = json.loads(message)
            request_id = data.get("request_id")
            command = data.get("command") or ""
            payload = data.get("payload") or {}
            if command == "get_status":
                executor = _STATUS_EXECUTOR
            elif command == "get_runtime_metrics":
                # Sampling process memory must not queue behind game commands.
                executor = _METRICS_EXECUTOR
            elif command == "describe_engine":
                # Engine startup may import a large runtime. Keep it away from
                # frame navigation and other latency-sensitive game commands.
                executor = _ENGINE_INSPECTION_EXECUTOR
            elif command == "reload_engines":
                executor = _ENGINE_RELOAD_EXECUTOR
            else:
                executor = _COMMAND_EXECUTOR
            executor.submit(
                COMMAND_TRANSPORT.process,
                request_id,
                command,
                payload,
                lightweight_status=command == "get_status",
            )
        except Exception as error:  # pylint: disable=broad-except
            emit(
                {
                    "request_id": None,
                    "command": "",
                    "error": str(error),
                    "timestamp": now_iso(),
                }
            )


if __name__ == "__main__":
    main()
