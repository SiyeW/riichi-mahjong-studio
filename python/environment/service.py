import copy
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

try:
    import psutil
except ModuleNotFoundError:
    psutil = None

import auto_analysis_session
import decision_analysis_session
import engine_management
import game_flow
import game_setup
import game_tree
import legal_actions
import opponent_analysis_session
import play_prefetch_session
import record_commands
import record_session
import result_view
import round_actions
import round_progression
import snapshot_state
import table_view
import tree_view
from action_recommendation_adapter import (
    choose_ai_action,
    get_and_reset_ai_thinking_time_s,
    get_latest_action_recommendation_debug,
    set_thinking_time_bounds,
)
from action_recommendation_gateway import ActionRecommendationGateway
from analysis_cache import (
    ANALYSIS_SOURCES_FIELD,
    OPPONENT_ANALYSIS_CACHE_FIELD,
    attach_analysis_context,
    cache_key_context,
    compact_opponent_analysis,
    migrate_analysis_cache_storage,
    prune_stale_cache_entries,
    register_analysis_source,
)
from engine_runtime import EngineRuntimeRegistry
from opponent_prediction_coordinator import OpponentPredictionCoordinator
from opponent_prediction_gateway import get_latest_opponent_prediction_mjai
from mjai_stream import build_mjai_events_from_actions, build_mjai_stream
from service_debug import run_debug_scenario
from service_helpers import (
    DORA_INDICATOR_POSITIONS,
    RINSHAN_DRAW_POSITIONS,
    URA_INDICATOR_POSITIONS,
    actor_just_drew,
    build_comparison_result,
    build_special_action_comparison_result,
    build_reaction_comparison_result,
    get_abortive_reason_label,
    now_iso,
)
from settlement import (
    can_ankan,
    can_declare_riichi,
    compute_hora_result,
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
_MJAI_STREAM_CACHE = {}
_MJAI_STREAM_CACHE_MAX = 64
_LEGAL_ACTIONS_CACHE = {}
_LEGAL_ACTIONS_CACHE_MAX = 4096
_MJAI_HASH_MASK = (1 << 64) - 1
_MJAI_HASH_MULTIPLIER = 1000003
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
        build_state=lambda: build_state_payload(consume_thinking_time=False),
    ),
)


OPPONENT_ANALYSIS = opponent_analysis_session.OpponentAnalysisSession(
    STATE,
    _STATE_LOCK,
    OPPONENT_PREDICTIONS,
    ENGINE_MANAGEMENT,
    opponent_analysis_session.OpponentAnalysisDependencies(
        build_mjai_stream_bundle=lambda *args, **kwargs: get_cached_mjai_stream_bundle(
            *args, **kwargs
        ),
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
        build_mjai_stream_bundle=lambda *args, **kwargs: get_cached_mjai_stream_bundle(
            *args, **kwargs
        ),
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
        build_state=lambda: build_state_payload(),
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
        build_mjai_stream_bundle=lambda *args, **kwargs: get_cached_mjai_stream_bundle(
            *args, **kwargs
        ),
        get_node_legal_actions=lambda *args, **kwargs: get_node_legal_actions(
            *args, **kwargs
        ),
        build_legal_actions=lambda *args, **kwargs: build_legal_actions(
            *args, **kwargs
        ),
        sync_snapshot=lambda snapshot: sync_snapshot_state(snapshot),
        ensure_game_loaded=lambda: ensure_game_loaded(),
        build_state=lambda *args, **kwargs: build_state_payload(*args, **kwargs),
        emit=emit,
    ),
)


ROUND_PROGRESSION = round_progression.RoundProgression(
    round_progression.RoundProgressionDependencies(
        create_initial_snapshot=lambda match_state: create_initial_snapshot(match_state),
        create_node=lambda *args, **kwargs: create_node(*args, **kwargs),
        attach_mainline=lambda *args, **kwargs: attach_mainline(*args, **kwargs),
        promote_mainline=lambda *args, **kwargs: promote_path_to_mainline(
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
        apply_pending_seat_switch=lambda snapshot: apply_pending_seat_switch_if_ready(
            snapshot
        ),
        materialize_automatic_reaction_decisions=lambda *args, **kwargs: _materialize_automatic_reaction_decisions(
            *args, **kwargs
        ),
        create_node=lambda *args, **kwargs: create_node(*args, **kwargs),
        attach_mainline=lambda *args, **kwargs: attach_mainline(*args, **kwargs),
        promote_mainline=lambda *args, **kwargs: promote_path_to_mainline(
            *args, **kwargs
        ),
        debug=debug_flow,
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
        build_mjai_stream_bundle=lambda *args, **kwargs: get_cached_mjai_stream_bundle(
            *args, **kwargs
        ),
        build_legal_actions=lambda *args, **kwargs: build_legal_actions(
            *args, **kwargs
        ),
        build_state=lambda *args, **kwargs: build_state_payload(*args, **kwargs),
        is_read_only_game=lambda game: is_read_only_game(game),
        find_existing_child=lambda *args, **kwargs: _find_existing_child(
            *args, **kwargs
        ),
        create_node=lambda *args, **kwargs: create_node(*args, **kwargs),
        attach_mainline=lambda *args, **kwargs: attach_mainline(*args, **kwargs),
        promote_mainline=lambda *args, **kwargs: promote_path_to_mainline(
            *args, **kwargs
        ),
        emit=emit,
    ),
)


def create_match_state(seed):
    return game_setup.create_match_state(
        seed,
        f"match_{STATE['nextGameId']:04d}",
    )


def sync_snapshot_state(snapshot):
    return snapshot_state.sync(snapshot)


def persist_snapshot_state(snapshot):
    return snapshot_state.persist(snapshot)


def get_wall_view(snapshot):
    """Return tile status for the full 136-tile wall."""
    sync_snapshot_state(snapshot)
    full_wall = copy.deepcopy(snapshot.get("fullWall") or [])
    if len(full_wall) != 136:
        return []

    draw_index = snapshot.get("drawIndex", 52)
    wall_len = len(snapshot.get("wall", []))
    dora_revealed = list(snapshot.get("doraIndicators", []))
    rinshan_remaining = list(snapshot.get("rinshanWall", []))
    dora_revealed_positions = set(DORA_INDICATOR_POSITIONS[:len(dora_revealed)])
    ura_revealed_positions = set(URA_INDICATOR_POSITIONS[:len(dora_revealed)])
    rinshan_drawn_count = 4 - len(rinshan_remaining)
    rinshan_drawn_positions = set(RINSHAN_DRAW_POSITIONS[:rinshan_drawn_count])

    result = []
    for idx, tile in enumerate(full_wall):
        if idx < 52:
            status = "dealt"
        elif 52 <= idx < draw_index:
            status = "drawn"
        elif draw_index <= idx < wall_len:
            status = "available"
        elif wall_len <= idx < 122:
            status = "kan_consumed"
        elif idx in DORA_INDICATOR_POSITIONS:
            status = "dora" if idx in dora_revealed_positions else "dora_unrevealed"
        elif idx in URA_INDICATOR_POSITIONS:
            status = "ura" if idx in ura_revealed_positions else "ura_unrevealed"
        elif 132 <= idx < 136:
            status = "rinshan_drawn" if idx in rinshan_drawn_positions else "available"
        else:
            status = "available"

        result.append({"index": idx, "tile": tile, "status": status})
    return result


def create_initial_snapshot(match_state, full_wall=None):
    return game_setup.create_initial_snapshot(match_state, full_wall)


def create_empty_game(seed):
    game_id = f"game_{STATE['nextGameId']:04d}"
    STATE["nextGameId"] += 1
    match_state = create_match_state(seed)
    match_state["matchId"] = f"match_{STATE['nextGameId'] - 1:04d}"
    root_snapshot = create_initial_snapshot(match_state)

    root_node_id = "n_root"
    start_kyoku_id = "n_1"
    nodes = {
        root_node_id: {
            "id": root_node_id,
            "type": "root",
            "parentId": None,
            "children": [start_kyoku_id],
            "mainChildId": start_kyoku_id,
            "action": None,
            "actor": None,
            "snapshot": root_snapshot,
            "analysisCache": {},
            "depth": 0,
        },
        start_kyoku_id: {
            "id": start_kyoku_id,
            "type": "action",
            "parentId": root_node_id,
            "children": [],
            "mainChildId": None,
            "action": {"type": "start_kyoku", "source": "system"},
            "actor": None,
            "snapshot": copy.deepcopy(root_snapshot),
            "analysisCache": {},
            "depth": 1,
        },
    }

    return {
        "gameId": game_id,
        "matchId": match_state["matchId"],
        "seed": seed,
        "createdAt": now_iso(),
        "metadata": {
            "label": match_state["matchId"],
            "source": "local-environment",
        },
        "matchConfig": {
            "matchType": match_state["matchType"],
            "players": match_state["players"],
            "westEntryEnabled": match_state["westEntryEnabled"],
            "maxBakaze": match_state["maxBakaze"],
            "maxKyoku": match_state["maxKyoku"],
        },
        "matchState": copy.deepcopy(match_state),
        "rootNodeId": root_node_id,
        "currentNodeId": start_kyoku_id,
        "mainLeafNodeId": start_kyoku_id,
        "nextNodeIndex": 2,
        "treeRevision": 1,
        "pendingReview": None,
        ANALYSIS_SOURCES_FIELD: {},
        "nodes": nodes,
    }


def validate_full_wall_tiles(tiles):
    return game_setup.validate_full_wall_tiles(tiles)


def resolve_round_root_id_for_node(game, node_id):
    cursor_id = node_id
    node = game["nodes"][node_id]
    if node.get("type") == "root":
        return node_id
    snapshot = node["snapshot"]
    round_index = int(snapshot.get("roundIndex", 0))
    honba = int(snapshot.get("honba", 0))
    parent_id = node.get("parentId")
    while parent_id:
        parent_node = game["nodes"][parent_id]
        if parent_node.get("type") == "root":
            break
        parent_snapshot = parent_node["snapshot"]
        if int(parent_snapshot.get("roundIndex", -1)) != round_index:
            break
        if int(parent_snapshot.get("honba", -1)) != honba:
            break
        cursor_id = parent_id
        parent_id = parent_node.get("parentId")
    return cursor_id


def collect_subtree_ids(game, root_id):
    result = []
    stack = [root_id]
    while stack:
        current = stack.pop()
        result.append(current)
        stack.extend(game["nodes"][current]["children"])
    return result


def reset_current_round_with_full_wall(full_wall):
    ensure_game_loaded()
    game = STATE["game"]
    current_node_id = game["currentNodeId"]
    old_round_root_id = resolve_round_root_id_for_node(game, current_node_id)
    round_root_node = game["nodes"][old_round_root_id]
    base_match_state = copy.deepcopy((round_root_node.get("snapshot") or {}).get("matchState") or game.get("matchState") or {})
    if not base_match_state:
        raise ValueError("无法确定当前局的对局元数据。")

    validated_wall = validate_full_wall_tiles(full_wall)
    next_snapshot = create_initial_snapshot(base_match_state, full_wall=validated_wall)
    next_snapshot["wallOrigin"] = "imported"

    subtree_ids = collect_subtree_ids(game, old_round_root_id)
    parent_id = round_root_node.get("parentId")
    new_round_root_id = f"n_{game['nextNodeIndex']}"
    game["nextNodeIndex"] += 1
    new_round_root_node = {
        "id": new_round_root_id,
        "type": round_root_node.get("type", "action"),
        "parentId": parent_id,
        "children": [],
        "mainChildId": None,
        "action": copy.deepcopy(round_root_node.get("action")),
        "actor": None if round_root_node.get("action") is None else round_root_node["action"].get("actor"),
        "snapshot": next_snapshot,
        "analysisCache": {},
        "depth": round_root_node.get("depth", 0),
    }

    if parent_id:
        parent_node = game["nodes"][parent_id]
        parent_node["children"] = [
            new_round_root_id if child_id == old_round_root_id else child_id
            for child_id in parent_node.get("children", [])
        ]
        if parent_node.get("mainChildId") == old_round_root_id:
            parent_node["mainChildId"] = new_round_root_id
    else:
        game["rootNodeId"] = new_round_root_id

    DECISION_ANALYSIS.purge(game["gameId"], subtree_ids)

    for node_id in subtree_ids:
        game["nodes"].pop(node_id, None)

    game["nodes"][new_round_root_id] = new_round_root_node
    game_tree.mark_tree_changed(game)
    AUTO_ANALYSIS.invalidate_timeline()
    game["currentNodeId"] = new_round_root_id
    promote_path_to_mainline(game, new_round_root_id)
    game["matchState"] = copy.deepcopy(next_snapshot["matchState"])
    game["matchState"]["matchId"] = game.get("matchId", game.get("gameId", "game"))
    purge_stale_mjai_stream_cache(game["gameId"])
    return new_round_root_id

def normalize_mode(value):
    return "research" if value == "research" else "play"


def normalize_seat(value):
    seat = int(value)
    if seat < 0 or seat > 3:
        raise ValueError("Seat must be between 0 and 3.")
    return seat


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


def get_current_node():
    ensure_game_loaded()
    game = STATE["game"]
    return game["nodes"][game["currentNodeId"]]


def _mjai_stream_cache_meta(snapshot):
    action_history = snapshot.get("actionHistory", []) or []
    last_action = action_history[-1] if action_history else {}
    return {
        "roundIndex": int(snapshot.get("roundIndex", 0)),
        "honba": int(snapshot.get("honba", 0)),
        "phase": snapshot.get("phase"),
        "actionCount": len(action_history),
        "lastActionType": last_action.get("type"),
        "lastActionActor": last_action.get("actor"),
        "lastActionPai": last_action.get("pai"),
        "startKyotaku": int(snapshot.get("startKyotaku", snapshot.get("kyotaku", 0))),
        "startScores": tuple(snapshot.get("startScores", snapshot.get("scores", [25000, 25000, 25000, 25000]))),
    }


def _get_mjai_stream_cache_key(game, node_id, seat, reveal_all=False):
    return (game.get("gameId"), node_id, int(seat), bool(reveal_all))


def reset_runtime_for_game_change():
    PLAY_PREFETCH.cancel()
    AUTO_ANALYSIS.reset_for_game_change()
    ENGINE_MANAGEMENT.advance_cache_epochs()
    DECISION_ANALYSIS.reset()
    _MJAI_STREAM_CACHE.clear()
    _LEGAL_ACTIONS_CACHE.clear()
    OPPONENT_PREDICTIONS.cancel_all()
    ACTION_RECOMMENDATIONS.reset_session()


def _mjai_event_hash(event):
    return hash(json.dumps(event, sort_keys=True, ensure_ascii=False)) & _MJAI_HASH_MASK


def _mjai_next_hash(current_hash, event):
    return ((current_hash * _MJAI_HASH_MULTIPLIER) ^ _mjai_event_hash(event)) & _MJAI_HASH_MASK


def _build_mjai_prefix_hashes(events):
    prefix_hashes = [0]
    current_hash = 0
    for event in events:
        current_hash = _mjai_next_hash(current_hash, event)
        prefix_hashes.append(current_hash)
    return prefix_hashes


def _extend_mjai_prefix_hashes(parent_prefix_hashes, suffix_events):
    prefix_hashes = list(parent_prefix_hashes or [0])
    current_hash = prefix_hashes[-1] if prefix_hashes else 0
    if not prefix_hashes:
        prefix_hashes.append(0)
    for event in suffix_events:
        current_hash = _mjai_next_hash(current_hash, event)
        prefix_hashes.append(current_hash)
    return prefix_hashes


def _build_mjai_stream_cache_entry(events, meta, prefix_hashes=None):
    if prefix_hashes is None:
        prefix_hashes = _build_mjai_prefix_hashes(events)
    event_hash = prefix_hashes[-1] if prefix_hashes else 0
    return {
        "meta": meta,
        "events": events,
        "eventHash": event_hash,
        "prefixHashes": prefix_hashes,
    }


def _store_mjai_stream_cache_entry(cache_key, entry):
    _MJAI_STREAM_CACHE[cache_key] = entry
    while len(_MJAI_STREAM_CACHE) > _MJAI_STREAM_CACHE_MAX:
        oldest_key = next(iter(_MJAI_STREAM_CACHE))
        _MJAI_STREAM_CACHE.pop(oldest_key, None)


def purge_stale_mjai_stream_cache(game_id):
    stale_keys = [key for key in _MJAI_STREAM_CACHE.keys() if key and key[0] == game_id]
    for key in stale_keys:
        _MJAI_STREAM_CACHE.pop(key, None)


def get_cached_mjai_stream_bundle(game, node_id, seat, *, reveal_all=False):
    node = game["nodes"][node_id]
    snapshot = node["snapshot"]
    sync_snapshot_state(snapshot)
    meta = _mjai_stream_cache_meta(snapshot)
    cache_key = _get_mjai_stream_cache_key(game, node_id, seat, reveal_all)
    cache_entry = _MJAI_STREAM_CACHE.get(cache_key)
    if cache_entry and cache_entry.get("meta") == meta:
        _MJAI_STREAM_CACHE.pop(cache_key, None)
        _MJAI_STREAM_CACHE[cache_key] = cache_entry
        return cache_entry

    parent_id = node.get("parentId")
    if parent_id:
        parent_node = game["nodes"][parent_id]
        parent_snapshot = parent_node["snapshot"]
        sync_snapshot_state(parent_snapshot)
        if (
            int(parent_snapshot.get("roundIndex", -1)) == int(snapshot.get("roundIndex", -2))
            and int(parent_snapshot.get("honba", -1)) == int(snapshot.get("honba", -2))
        ):
            parent_entry = get_cached_mjai_stream_bundle(
                game,
                parent_id,
                seat,
                reveal_all=reveal_all,
            )
            parent_events = parent_entry["events"]
            parent_actions = parent_snapshot.get("actionHistory", []) or []
            child_actions = snapshot.get("actionHistory", []) or []
            parent_len = len(parent_actions)
            if len(child_actions) >= parent_len and child_actions[:parent_len] == parent_actions:
                suffix_events = build_mjai_events_from_actions(
                    child_actions[parent_len:],
                    seat,
                    reveal_all=reveal_all,
                )
                events = parent_events + suffix_events
                prefix_hashes = _extend_mjai_prefix_hashes(parent_entry.get("prefixHashes"), suffix_events)
                cache_entry = _build_mjai_stream_cache_entry(events, meta, prefix_hashes)
                _store_mjai_stream_cache_entry(cache_key, cache_entry)
                return cache_entry

    events = build_mjai_stream(snapshot, seat, reveal_all=reveal_all)
    cache_entry = _build_mjai_stream_cache_entry(events, meta)
    _store_mjai_stream_cache_entry(cache_key, cache_entry)
    return cache_entry


def get_cached_mjai_stream(game, node_id, seat, *, reveal_all=False):
    return get_cached_mjai_stream_bundle(
        game,
        node_id,
        seat,
        reveal_all=reveal_all,
    )["events"]


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
    bundle = get_cached_mjai_stream_bundle(game, current_node_id, seat)
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
    mjai_events = build_mjai_stream(snapshot, seat)
    mjai_prefix_hashes = _build_mjai_prefix_hashes(mjai_events)
    mjai_events_hash = mjai_prefix_hashes[-1] if mjai_prefix_hashes else 0
    return choose_ai_action(
        ACTION_RECOMMENDATIONS,
        snapshot,
        seat,
        model_path,
        mjai_events=mjai_events,
        mjai_prefix_hashes=mjai_prefix_hashes,
        mjai_events_hash=mjai_events_hash,
        accumulate_thinking=accumulate_thinking,
        legal_actions=build_legal_actions(snapshot, controlled_seat=seat),
    )


def _refresh_reused_imported_child(game, child_id, action, snapshot):
    if game_tree.refresh_reused_imported_child(game, child_id, action, snapshot):
        AUTO_ANALYSIS.invalidate_timeline()


def create_node(game, parent_id, action, snapshot):
    sync_snapshot_state(snapshot)
    parent = game["nodes"][parent_id]
    is_decision = action_is_meaningful_decision(parent.get("snapshot"), action)
    previous_revision = int(game.get("treeRevision", 0))
    node_id = game_tree.create_node(
        game,
        parent_id,
        action,
        snapshot,
        is_decision=is_decision,
    )
    if int(game.get("treeRevision", 0)) != previous_revision:
        AUTO_ANALYSIS.invalidate_timeline()
    return node_id


def _may_promote_mainline(game, force=False):
    return (
        force
        or STATE.get("mode") != "play"
        or PLAY_PREFETCH.active_draft() is game
    )


def attach_mainline(parent_id, child_id, *, force=False):
    game = PLAY_PREFETCH.active_draft() or STATE["game"]
    if game_tree.attach_main_child(
        game,
        parent_id,
        child_id,
        replace_existing=_may_promote_mainline(game, force),
    ):
        AUTO_ANALYSIS.invalidate_timeline()


def promote_path_to_mainline(game, node_id, *, force=False):
    if not _may_promote_mainline(game, force):
        return
    if game_tree.promote_path_to_mainline(game, node_id):
        AUTO_ANALYSIS.invalidate_timeline()


def replace_pending_review_main_child(game, parent_id, proposed_id, chosen_id):
    changed = game_tree.replace_pending_review_main_child(
        game,
        parent_id,
        proposed_id,
        chosen_id,
    )
    if changed:
        AUTO_ANALYSIS.invalidate_timeline()
    return changed


def build_legal_actions(snapshot, controlled_seat=None):
    if controlled_seat is None:
        controlled_seat = STATE["controlledSeat"]
    return legal_actions.build_legal_actions(
        snapshot,
        normalize_seat(controlled_seat),
        build_player_state=build_player_state,
        can_declare_tsumo=can_declare_tsumo,
        can_declare_riichi=can_declare_riichi,
        can_declare_kyuushu_kyuuhai=ROUND_PROGRESSION.can_declare_kyuushu_kyuuhai,
        get_ankan_candidates=get_ankan_candidates,
        get_legal_kan_actions=get_legal_kan_actions,
        build_local_reaction_actions=_build_local_reaction_actions,
        debug=debug_flow,
    )


def _legal_actions_snapshot_signature(snapshot, controlled_seat):
    hands = snapshot.get("hands") or [[], [], [], []]
    action_history = snapshot.get("actionHistory") or []
    last_action = action_history[-1] if action_history else {}
    if not isinstance(last_action, dict):
        last_action = {}
    return (
        snapshot.get("phase"),
        snapshot.get("currentActor"),
        tuple(hands[controlled_seat]),
        tuple(snapshot.get("scores") or []),
        tuple(snapshot.get("riichiAccepted") or []),
        snapshot.get("riichiDiscardState"),
        snapshot.get("pendingRiichiSeat"),
        len(action_history),
        last_action.get("type"),
        last_action.get("actor"),
        last_action.get("pai"),
        tuple(len(river) for river in (snapshot.get("rivers") or [])),
        tuple(len(melds) for melds in (snapshot.get("melds") or [])),
        id(snapshot.get("reactionWindow")),
        id(snapshot.get("kanReactionWindow")),
    )


def get_node_legal_actions(game, node_id, controlled_seat=None):
    node = game["nodes"][node_id]
    snapshot = node["snapshot"]
    if controlled_seat is None:
        controlled_seat = STATE["controlledSeat"]
    controlled_seat = normalize_seat(controlled_seat)

    if STATE.get("mode") != "research":
        return build_legal_actions(snapshot, controlled_seat=controlled_seat)

    cache_key = (
        id(game),
        node_id,
        controlled_seat,
        _legal_actions_snapshot_signature(snapshot, controlled_seat),
    )
    cached = _LEGAL_ACTIONS_CACHE.get(cache_key)
    if cached is not None:
        return copy.deepcopy(cached)

    actions = build_legal_actions(snapshot, controlled_seat=controlled_seat)
    if len(_LEGAL_ACTIONS_CACHE) >= _LEGAL_ACTIONS_CACHE_MAX:
        _LEGAL_ACTIONS_CACHE.pop(next(iter(_LEGAL_ACTIONS_CACHE)))
    _LEGAL_ACTIONS_CACHE[cache_key] = copy.deepcopy(actions)
    return actions


def action_is_meaningful_decision(parent_snapshot, action):
    if not isinstance(parent_snapshot, dict) or not isinstance(action, dict):
        return False
    try:
        actor = normalize_seat(action.get("actor"))
        return len(build_legal_actions(parent_snapshot, controlled_seat=actor)) > 1
    except (KeyError, TypeError, ValueError):
        return False


def controlled_seat_has_pending_action(snapshot):
    return len(build_legal_actions(snapshot)) > 0


def _reaction_window_field(snapshot):
    if snapshot.get("phase") == "reaction_window":
        return "reactionWindow"
    if snapshot.get("phase") == "kan_reaction_window":
        return "kanReactionWindow"
    return None


def _reaction_decision_snapshot(snapshot, seat):
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


def _reaction_decision_action(response, seat, source):
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


def _append_reaction_decision_node(game, response, seat, source="ai_reaction_decision"):
    parent_id = game["currentNodeId"]
    parent_snapshot = game["nodes"][parent_id]["snapshot"]
    if len(build_legal_actions(parent_snapshot, controlled_seat=seat)) <= 1:
        return None
    action = _reaction_decision_action(response, seat, source)
    next_snapshot = _reaction_decision_snapshot(parent_snapshot, seat)
    child_id = create_node(game, parent_id, action, next_snapshot)
    child = game["nodes"][child_id]
    child["type"] = "decision"
    child["isDecision"] = True
    attach_mainline(parent_id, child_id)
    game["currentNodeId"] = child_id
    promote_path_to_mainline(game, child_id)
    return child_id


def _materialize_automatic_reaction_decisions(game, snapshot, selected):
    window_field = _reaction_window_field(snapshot)
    reaction_window = snapshot.get(window_field) if window_field else None
    if not isinstance(reaction_window, dict):
        return snapshot
    selected = selected if isinstance(selected, dict) else {}
    selected_seat = selected.get("seat")
    selected_response = selected.get("response") if isinstance(selected.get("response"), dict) else {}
    selected_type = str(selected_response.get("type") or "none")

    for item in reaction_window.get("reactions", []):
        if not isinstance(item, dict):
            continue
        try:
            seat = normalize_seat(item.get("seat"))
        except (TypeError, ValueError):
            continue
        response = item.get("response") if isinstance(item.get("response"), dict) else {}
        if selected_type != "none" and seat == selected_seat:
            continue
        _append_reaction_decision_node(game, response, seat)

    return game["nodes"][game["currentNodeId"]]["snapshot"]


def _shift_subtree_depth(game, root_id, delta):
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


def _insert_reaction_decision_chain(game, parent_id, child_id, decisions, source):
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
        node_id = f"n_{game['nextNodeIndex']}"
        game["nextNodeIndex"] += 1
        while node_id in nodes:
            node_id = f"n_{game['nextNodeIndex']}"
            game["nextNodeIndex"] += 1
        action = _reaction_decision_action(response, seat, source)
        next_snapshot = _reaction_decision_snapshot(previous_snapshot, seat)
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
    parent["children"] = [first_id if value == child_id else value for value in original_children]
    if parent.get("mainChildId") == child_id:
        parent["mainChildId"] = first_id
    nodes[previous_id]["children"] = [child_id]
    nodes[previous_id]["mainChildId"] = child_id
    child["parentId"] = previous_id
    _shift_subtree_depth(game, child_id, len(inserted_ids))
    game_tree.mark_tree_changed(game)
    return len(inserted_ids)


def repair_reaction_decision_nodes(game):
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
        snapshot = parent.get("snapshot") or {}
        phase = str(snapshot.get("phase") or "")
        if phase not in ("reaction_window", "kan_reaction_window"):
            continue
        window_field = _reaction_window_field(snapshot)
        reaction_window = snapshot.get(window_field) if window_field else None
        if not isinstance(reaction_window, dict):
            continue
        child_action = child.get("action") or {}
        child_type = str(child_action.get("type") or "")
        if child_type == "none":
            continue

        no_reaction_followups = {"tsumo", "reach_accepted", "ryukyoku"}
        effective_reactions = {"chi", "pon", "daiminkan", "hora"}
        if phase == "kan_reaction_window":
            no_reaction_followups.add("dora")
        if child_type in no_reaction_followups:
            mode = "all_passed"
        elif local_record and child_type in effective_reactions:
            mode = "recorded_responses"
        else:
            continue

        working_snapshot = snapshot
        decisions = []
        for item in reaction_window.get("reactions", []):
            if not isinstance(item, dict):
                continue
            try:
                seat = normalize_seat(item.get("seat"))
            except (TypeError, ValueError):
                continue
            response = item.get("response") if isinstance(item.get("response"), dict) else {}
            response_type = str(response.get("type") or "none")
            if mode == "all_passed" and response_type != "none":
                continue
            if (
                mode == "recorded_responses"
                and seat == child_action.get("actor")
                and response_type == child_type
            ):
                continue
            if len(build_legal_actions(working_snapshot, controlled_seat=seat)) <= 1:
                continue
            decisions.append((seat, response))
            working_snapshot = _reaction_decision_snapshot(working_snapshot, seat)

        decision_source = "recorded_reaction_decision" if local_record else "inferred_reaction_pass"
        inserted += _insert_reaction_decision_chain(
            game,
            parent_id,
            child_id,
            decisions,
            decision_source,
        )
    return inserted


def get_active_reaction_window(snapshot):
    if snapshot.get("phase") == "reaction_window":
        return snapshot.get("reactionWindow") or {}
    if snapshot.get("phase") == "kan_reaction_window":
        return snapshot.get("kanReactionWindow") or {}
    return {}


def get_legal_kan_actions(snapshot, actor):
    return legal_actions.get_legal_kan_actions(snapshot, actor)


def _unique_consumed_combinations(tiles, count):
    return legal_actions._unique_consumed_combinations(tiles, count)


def _build_local_chi_actions(snapshot, actor, called_tile):
    return legal_actions._build_local_chi_actions(snapshot, actor, called_tile)


def _build_local_reaction_actions(snapshot, actor):
    return legal_actions._build_local_reaction_actions(
        snapshot,
        actor,
        can_resolve_hora_reaction=ROUND_ACTIONS.can_resolve_hora_reaction,
    )


def apply_pending_seat_switch_if_ready(snapshot):
    pending_seat = STATE.get("pendingSeatSwitch")
    if pending_seat is None:
        return False

    STATE["controlledSeat"] = pending_seat
    STATE["pendingSeatSwitch"] = None
    return True


def tree_node_is_visible_to_seat(node, seat):
    return tree_view.node_is_visible_to_seat(node, seat)


def resolve_visible_tree_cursor(game, node_id, seat):
    return tree_view.resolve_visible_cursor(game, node_id, seat)


def normalize_current_tree_cursor(game, seat):
    return tree_view.normalize_current_cursor(game, seat)


def build_tree_view(game, current_node_id):
    return tree_view.build_tree_view(
        game,
        current_node_id,
        controlled_seat=int(STATE["controlledSeat"]),
        legal_actions_resolver=get_node_legal_actions,
        result_info_builder=build_result_info,
    )


def build_tree_cursor_view(game, current_node_id):
    return tree_view.build_cursor_view(
        game,
        current_node_id,
        controlled_seat=int(STATE["controlledSeat"]),
        round_root_resolver=resolve_round_root_id_for_node,
    )


def rank_scores(scores):
    return result_view.rank_scores(scores)


def build_result_info(snapshot):
    sync_snapshot_state(snapshot)
    return result_view.build_result_info(snapshot, int(STATE["controlledSeat"]))


def resolve_last_drawn_tile(snapshot, seat):
    sync_snapshot_state(snapshot)
    return table_view.resolve_last_drawn_tile(snapshot, seat)


def resolve_display_last_draw_state(snapshot):
    sync_snapshot_state(snapshot)
    return table_view.resolve_display_last_draw_state(snapshot)


def resolve_auto_advance_mode(snapshot):
    sync_snapshot_state(snapshot)
    if is_read_only_game():
        return None
    actor = int(snapshot.get("currentActor", 0))
    controlled_seat = int(STATE.get("controlledSeat", 0))
    phase = snapshot.get("phase")

    if actor == controlled_seat:
        return None

    if phase == "reach_declaration":
        return "ai_think"

    if phase == "discard" and snapshot.get("riichiAccepted", [False, False, False, False])[actor]:
        if actor_just_drew(snapshot, actor) and can_declare_tsumo(snapshot, actor):
            return "ai_think"
        if can_ankan(snapshot, actor):
            return "ai_think"
        return "auto_progress"

    return None


def build_table_view(snapshot):
    sync_snapshot_state(snapshot)
    game = STATE.get("game")
    return table_view.build_table_view(
        snapshot,
        controlled_seat=int(STATE["controlledSeat"]),
        visible_hands=bool(STATE["visibleHands"]),
        match_id=game.get("matchId") if isinstance(game, dict) else None,
        auto_advance_mode=resolve_auto_advance_mode(snapshot),
        result_info=build_result_info(snapshot),
    )


def build_match_summary(game, snapshot):
    sync_snapshot_state(snapshot)
    return table_view.build_match_summary(game, snapshot)


def build_view_payload(compact_tree=False):
    if not STATE["gameLoaded"] or not STATE["game"]:
        return {
            "gameId": None,
            "matchId": None,
            "readOnly": False,
            "sourceUrl": None,
            "readOnlyReason": None,
            "currentNodeId": None,
            "nodeComment": "",
            "opponentAnalysis": None,
            "matchSummary": None,
            "table": None,
            "legalActions": [],
            "analysis": None,
            "comparison": None,
            "pendingReview": None,
            "tree": None,
        }

    game = STATE["game"]
    metadata = game.get("metadata") or {}
    current_node_id = normalize_current_tree_cursor(game, STATE["controlledSeat"])
    current_node = game["nodes"][current_node_id]
    snapshot = current_node["snapshot"]
    sync_snapshot_state(snapshot)
    opponent_analysis = None
    if STATE.get("opponentAnalysisEnabled"):
        # Opponent analysis owns a separate worker and starts independently of the decision engine.
        # Ship the current node's cache (or an explicit miss) with the view so the
        # renderer can distinguish an instant cache swap from waiting for inference.
        opponent_analysis = OPPONENT_ANALYSIS.current()
    legal_actions = get_node_legal_actions(game, current_node_id)
    if legal_actions and STATE.get("decisionRecommendationsEnabled", True):
        # Rendering a position must never wait for decision-engine inference. Cached results
        # are returned immediately; a miss is delivered later via analysis_ready.
        analysis = DECISION_ANALYSIS.get_or_schedule(
            current_node,
            snapshot,
            legal_actions,
        )
    else:
        analysis = None
    return {
        "gameId": game["gameId"],
        "matchId": game.get("matchId") or game["gameId"],
        "readOnly": bool(metadata.get("readOnly")),
        "sourceUrl": metadata.get("sourceUrl"),
        "readOnlyReason": metadata.get("readOnlyReason"),
        "currentNodeId": current_node_id,
        "nodeComment": str(current_node.get("comment") or ""),
        "opponentAnalysis": opponent_analysis,
        "matchSummary": build_match_summary(game, snapshot),
        "table": build_table_view(snapshot),
        "legalActions": legal_actions,
        "analysis": analysis,
        "comparison": copy.deepcopy(current_node.get("comparison")),
        "pendingReview": copy.deepcopy(game.get("pendingReview")),
        "tree": build_tree_cursor_view(game, current_node_id) if compact_tree else build_tree_view(game, current_node_id),
    }


def build_state_payload(*, consume_thinking_time=True):
    return {
        "mode": STATE["mode"],
        "controlledSeat": STATE["controlledSeat"],
        "pendingSeatSwitch": STATE["pendingSeatSwitch"],
        "visibleHands": STATE["visibleHands"],
        "license": copy.deepcopy(STATE.get("license")),
        "device": ACTION_RECOMMENDATIONS.device_str,
        "gameLoaded": STATE["gameLoaded"],
        "aiThinkingTimeS": get_and_reset_ai_thinking_time_s() if consume_thinking_time else 0.0,
        "modelPerformance": {
            "decision": ENGINE_MANAGEMENT.decision_response_ms(),
            "opponentAnalysis": OPPONENT_PREDICTIONS.average_response_ms(),
        },
        "analysisVisibility": {
            "decisionRecommendations": bool(STATE.get("decisionRecommendationsEnabled", True)),
            "opponentAnalysis": bool(STATE.get("opponentAnalysisEnabled", False)),
        },
        "modelActivity": {
            "decision": ACTION_RECOMMENDATIONS.get_activity(),
            "opponentAnalysis": OPPONENT_PREDICTIONS.activity_state(),
            "errors": {
                "decision": ACTION_RECOMMENDATIONS.get_activity_errors(),
                "opponentAnalysis": OPPONENT_PREDICTIONS.activity_error(),
            },
        },
        "modelRuntime": {
            "decision": ACTION_RECOMMENDATIONS.runtime_status(),
            "opponentAnalysis": OPPONENT_PREDICTIONS.runtime_status(),
        },
        "autoAnalysis": AUTO_ANALYSIS.status(
            include_timeline=STATE.get("mode") == "research"
        ),
    }


def build_response(request_id, command, extra=None, compact_tree=False):
    view = build_view_payload(compact_tree=compact_tree)
    payload = {
        "request_id": request_id,
        "command": command,
        "state": build_state_payload(),
        "view": view,
        "timestamp": now_iso(),
    }
    if extra:
        payload.update(extra)
    return payload


def build_status_response(request_id):
    return {
        "request_id": request_id,
        "command": "get_status",
        "state": build_state_payload(consume_thinking_time=False),
        "timestamp": now_iso(),
    }


def _private_memory_bytes(process):
    if psutil is None:
        return 0
    try:
        memory = process.memory_full_info()
        value = getattr(memory, "uss", None)
        if value is not None:
            return max(0, int(value))
    except (psutil.AccessDenied, psutil.NoSuchProcess, psutil.ZombieProcess):
        pass

    try:
        return max(0, int(process.memory_info().rss))
    except (psutil.AccessDenied, psutil.NoSuchProcess, psutil.ZombieProcess):
        return 0


def build_runtime_memory_metrics():
    if psutil is None:
        raise RuntimeError("Runtime memory metrics require psutil.")
    root = psutil.Process(os.getpid())
    backend_private_bytes = _private_memory_bytes(root)
    engine_private_bytes = 0
    engine_process_count = 0
    seen = {root.pid}
    try:
        descendants = root.children(recursive=True)
    except (psutil.AccessDenied, psutil.NoSuchProcess):
        descendants = []
    for process in descendants:
        if process.pid in seen:
            continue
        seen.add(process.pid)
        private_bytes = _private_memory_bytes(process)
        if private_bytes <= 0:
            continue
        engine_private_bytes += private_bytes
        engine_process_count += 1
    return {
        "backendPrivateBytes": backend_private_bytes,
        "enginePrivateBytes": engine_private_bytes,
        "engineProcessCount": engine_process_count,
    }




def find_user_reaction_response(snapshot, action_type):
    reaction_window = get_active_reaction_window(snapshot)
    for item in reaction_window.get("reactions", []):
        if item.get("seat") != STATE["controlledSeat"]:
            continue

        response = item.get("response") or {}
        response_type = response.get("type")
        if action_type == "none" and response_type == "none":
            return {"seat": STATE["controlledSeat"], "response": response, "priority": 0}
        if action_type == response_type:
            if action_type == "chi":
                continue
            return {
                "seat": STATE["controlledSeat"],
                "response": response,
                "priority": ROUND_ACTIONS.get_reaction_priority(response_type),
            }

    if action_type == "none":
        return {
            "seat": STATE["controlledSeat"],
            "response": {"type": "none", "actor": STATE["controlledSeat"]},
            "priority": 0,
        }
    return None


def synthesize_user_reaction_response(snapshot, action_type, variant=None, candidate_id=None):
    actor = STATE["controlledSeat"]
    reaction_entries = _build_local_reaction_actions(snapshot, actor)
    pending_discard = snapshot.get("pendingDiscard") or {}
    pending_kan = snapshot.get("pendingKan") or {}

    if action_type == "none":
        return {
            "seat": STATE["controlledSeat"],
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
        "priority": ROUND_ACTIONS.get_reaction_priority(action_type),
    }


def build_review_action_payload(action_type, *, pai=None, variant=None, source="user_review"):
    action = {
        "type": action_type,
        "actor": STATE["controlledSeat"],
        "source": source,
    }
    if pai is not None:
        action["pai"] = pai
    if variant is not None:
        action["variant"] = variant
    return action


def create_user_discard_child_snapshot(parent_snapshot, tile, source="user", from_drawn=None):
    actor = parent_snapshot["currentActor"]
    next_snapshot = copy.deepcopy(parent_snapshot)

    if parent_snapshot["phase"] == "reach_declaration":
        if tile not in parent_snapshot["hands"][actor]:
            raise ValueError(f"Tile {tile} not in hand.")

        tsumogiri = bool(from_drawn)
        ROUND_ACTIONS.materialize_reach_declaration_discard(
            next_snapshot,
            actor,
            tile,
            tsumogiri,
        )
        persist_snapshot_state(next_snapshot)
        next_snapshot["reactionWindow"] = (
            None
            if STATE.get("mode") == "play"
            else ROUND_ACTIONS.evaluate_reactions(next_snapshot)
        )
        action = build_review_action_payload("dahai", pai=tile, source=source)
        action["riichi"] = True
        action["tsumogiri"] = bool(from_drawn)
        return next_snapshot, action

    ROUND_ACTIONS.apply_discard(
        next_snapshot,
        actor,
        tile,
        from_drawn=from_drawn,
    )
    next_snapshot["reactionWindow"] = (
        None
        if STATE.get("mode") == "play"
        else ROUND_ACTIONS.evaluate_reactions(next_snapshot)
    )
    action = build_review_action_payload("dahai", pai=tile, source=source)
    action["tsumogiri"] = bool(from_drawn)
    return next_snapshot, action


def create_discard_phase_special_child_snapshot(parent_snapshot, action_type, variant=None, source="user"):
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
        persist_snapshot_state(next_snapshot)
        action = build_review_action_payload("reach", variant="declare", source=source)
        return next_snapshot, action

    if action_type == "ryukyoku" and variant == "kyuushu_kyuuhai":
        if not ROUND_PROGRESSION.can_declare_kyuushu_kyuuhai(parent_snapshot, actor):
            raise ValueError("This hand cannot declare 9 terminals abortive draw.")
        ROUND_PROGRESSION.mark_abortive_ryukyoku(next_snapshot, variant)
        action = {
            "type": "ryukyoku",
            "actor": STATE["controlledSeat"],
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

        ROUND_PROGRESSION.promote_delayed_dora_reveal(next_snapshot)
        ROUND_PROGRESSION.reveal_all_pending_dora(next_snapshot)
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
        persist_snapshot_state(next_snapshot)
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
                item for item in get_legal_kan_actions(parent_snapshot, actor)
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
        ROUND_ACTIONS.apply_self_kan_action(next_snapshot, response)
        action = copy.deepcopy(response)
        action["source"] = source
        return next_snapshot, action

    raise ValueError(f"Unsupported discard-phase special action: {action_type} ({variant})")


def create_reaction_child_snapshot(parent_snapshot, action_type, variant=None, candidate_id=None):
    selected = (
        synthesize_user_reaction_response(parent_snapshot, action_type, variant, candidate_id)
        if candidate_id
        else find_user_reaction_response(parent_snapshot, action_type)
    )
    if selected is None:
        selected = synthesize_user_reaction_response(parent_snapshot, action_type, variant)
    if selected is None:
        raise ValueError(f"Unsupported or unavailable reaction action: {action_type} ({variant})")
    next_snapshot = copy.deepcopy(parent_snapshot)
    ROUND_ACTIONS.apply_reaction_action(next_snapshot, selected)
    action = copy.deepcopy(selected["response"])
    action["source"] = "user_reaction"
    if action.get("type") == "none":
        action["decisionOnly"] = True
    return next_snapshot, selected, action
















































def advance_to_next_user_turn(game):
    GAME_FLOW.advance(game)


def _reuse_or_review_existing_child(
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
        _refresh_reused_imported_child(game, existing_id, action, next_snapshot)
    if comparison is not None and game["nodes"][existing_id].get("comparison") != comparison:
        game["nodes"][existing_id]["comparison"] = copy.deepcopy(comparison)
        game_tree.mark_tree_changed(game)
    if not force_commit and comparison is not None and should_trigger_review(comparison):
        register_pending_review(game, parent_id, existing_id, comparison)
        game["currentNodeId"] = parent_id
        return False
    attach_mainline(parent_id, existing_id)
    game["currentNodeId"] = existing_id
    promote_path_to_mainline(game, existing_id)
    return True


def _find_existing_child(game, parent_id, action):
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


def finalize_pending_review(
    tile=None,
    action_type=None,
    variant=None,
    confirm_proposed=False,
    from_drawn=None,
    candidate_id=None,
):
    ensure_game_loaded()
    game = STATE["game"]
    pending_review = game.get("pendingReview")
    if not pending_review:
        raise ValueError("No pending review to finalize.")

    parent_id = pending_review["parentNodeId"]
    proposed_node_id = pending_review["proposedNodeId"]
    parent_snapshot = game["nodes"][parent_id]["snapshot"]
    parent_node = game["nodes"][parent_id]
    analysis_key = DECISION_ANALYSIS.cache_key(parent_snapshot)
    DECISION_ANALYSIS.ensure_cached(parent_node, parent_snapshot)

    if confirm_proposed:
        chosen_node_id = proposed_node_id
    else:
        if pending_review.get("phase") == "discard":
            if action_type:
                if (variant or action_type) == pending_review["chosenKey"]:
                    chosen_node_id = proposed_node_id
                else:
                    next_snapshot, action = create_discard_phase_special_child_snapshot(parent_snapshot, action_type, variant, source="user_review")
                    existing_id = _find_existing_child(game, parent_id, action)
                    if existing_id is not None:
                        chosen_node_id = existing_id
                        _refresh_reused_imported_child(game, existing_id, action, next_snapshot)
                    else:
                        chosen_node_id = create_node(game, parent_id, action, next_snapshot)
                        if analysis_key in parent_node["analysisCache"]:
                            comparison = build_special_action_comparison_result(
                                parent_node["analysisCache"][analysis_key],
                                action_type,
                                STATE["controlledSeat"],
                                variant,
                            )
                            if comparison is not None:
                                game["nodes"][chosen_node_id]["comparison"] = comparison
            elif not tile:
                raise ValueError("A tile or action type must be provided to finalize a discard review.")
            elif tile == pending_review["chosenKey"] and bool(from_drawn) == bool(pending_review.get("chosenFromDrawn")):
                chosen_node_id = proposed_node_id
            else:
                next_snapshot, action = create_user_discard_child_snapshot(parent_snapshot, tile, from_drawn=from_drawn)
                existing_id = _find_existing_child(game, parent_id, action)
                if existing_id is not None:
                    chosen_node_id = existing_id
                    _refresh_reused_imported_child(game, existing_id, action, next_snapshot)
                else:
                    chosen_node_id = create_node(game, parent_id, action, next_snapshot)
                    if analysis_key in parent_node["analysisCache"]:
                        comparison = build_comparison_result(
                            parent_node["analysisCache"][analysis_key],
                            tile,
                            STATE["controlledSeat"],
                            from_drawn,
                        )
                        if comparison is not None:
                            game["nodes"][chosen_node_id]["comparison"] = comparison
        elif pending_review.get("phase") == "special":
            if tile:
                if tile == pending_review["chosenKey"] and bool(from_drawn) == bool(pending_review.get("chosenFromDrawn")):
                    chosen_node_id = proposed_node_id
                else:
                    next_snapshot, action = create_user_discard_child_snapshot(parent_snapshot, tile, from_drawn=from_drawn)
                    existing_id = _find_existing_child(game, parent_id, action)
                    if existing_id is not None:
                        chosen_node_id = existing_id
                        _refresh_reused_imported_child(game, existing_id, action, next_snapshot)
                    else:
                        chosen_node_id = create_node(game, parent_id, action, next_snapshot)
                        if analysis_key in parent_node["analysisCache"]:
                            comparison = build_comparison_result(
                                parent_node["analysisCache"][analysis_key],
                                tile,
                                STATE["controlledSeat"],
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
                    next_snapshot, action = create_discard_phase_special_child_snapshot(parent_snapshot, action_type, variant, source="user_review")
                    existing_id = _find_existing_child(game, parent_id, action)
                    if existing_id is not None:
                        chosen_node_id = existing_id
                        _refresh_reused_imported_child(game, existing_id, action, next_snapshot)
                    else:
                        chosen_node_id = create_node(game, parent_id, action, next_snapshot)
                        if analysis_key in parent_node["analysisCache"]:
                            comparison = build_special_action_comparison_result(
                                parent_node["analysisCache"][analysis_key],
                                action_type,
                            STATE["controlledSeat"],
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
                next_snapshot, _selected, action = create_reaction_child_snapshot(
                    parent_snapshot,
                    action_type,
                    variant,
                    candidate_id,
                )
                action["source"] = "user_review"
                existing_id = _find_existing_child(game, parent_id, action)
                if existing_id is not None:
                    chosen_node_id = existing_id
                    _refresh_reused_imported_child(game, existing_id, action, next_snapshot)
                else:
                    chosen_node_id = create_node(game, parent_id, action, next_snapshot)
                if analysis_key in parent_node["analysisCache"]:
                    comparison = build_reaction_comparison_result(
                        parent_node["analysisCache"][analysis_key],
                        action_type,
                        STATE["controlledSeat"],
                        variant,
                        candidate_id,
                    )
                    if comparison is not None:
                        game["nodes"][chosen_node_id]["comparison"] = comparison

    game["pendingReview"] = None
    if not replace_pending_review_main_child(
        game,
        parent_id,
        proposed_node_id,
        chosen_node_id,
    ):
        attach_mainline(parent_id, chosen_node_id)
    game["currentNodeId"] = chosen_node_id
    promote_path_to_mainline(game, chosen_node_id)
    finalize_pending_review_advance(game, game["nodes"][chosen_node_id]["snapshot"])


def register_pending_review(game, parent_id, child_id, comparison, chosen_from_drawn=False):
    attach_mainline(parent_id, child_id)
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


def should_trigger_review(comparison):
    if not STATE.get("decisionRecommendationsEnabled", True):
        return False
    if comparison is None:
        return False
    training = ENGINE_MANAGEMENT.training_config()
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


def finalize_pending_review_advance(game, node_snapshot):
    if node_snapshot["phase"] in ("game_end", "match_end", "round_result"):
        return
    if (
        STATE.get("mode") != "play"
        and node_snapshot["phase"] not in ("reaction_window", "kan_reaction_window", "reach_declaration")
    ):
        advance_to_next_user_turn(game)


def submit_reviewable_child(game, parent_id, child_id, comparison, force_commit=False, chosen_from_drawn=False):
    if not force_commit and should_trigger_review(comparison):
        register_pending_review(game, parent_id, child_id, comparison, chosen_from_drawn=chosen_from_drawn)
        game["currentNodeId"] = parent_id
        return False

    attach_mainline(parent_id, child_id)
    game["currentNodeId"] = child_id
    promote_path_to_mainline(game, child_id)
    return True


def submit_discard_phase_special_action(action_type, variant=None):
    ensure_game_loaded()
    game = STATE["game"]
    if game.get("pendingReview"):
        finalize_pending_review(action_type=action_type, variant=variant)
        return

    current_snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
    current_node = game["nodes"][game["currentNodeId"]]
    actor = current_snapshot["currentActor"]

    if current_snapshot["phase"] != "discard":
        raise ValueError("This action is only legal during discard selection.")
    if actor != STATE["controlledSeat"]:
        raise ValueError("Only the controlled seat can declare this action.")

    next_snapshot, action = create_discard_phase_special_child_snapshot(current_snapshot, action_type, variant, source="user")
    analysis_key = DECISION_ANALYSIS.cache_key(current_snapshot)
    comparison = None
    DECISION_ANALYSIS.ensure_cached(current_node, current_snapshot)
    if analysis_key in current_node["analysisCache"]:
        comparison = build_special_action_comparison_result(
            current_node["analysisCache"][analysis_key],
            action_type,
            actor,
            variant,
        )

    parent_id = game["currentNodeId"]
    existing_id = _find_existing_child(game, parent_id, action)
    if existing_id is not None:
        _reuse_or_review_existing_child(
            game,
            parent_id,
            existing_id,
            comparison,
            action=action,
            next_snapshot=next_snapshot,
        )
        return

    child_id = create_node(game, parent_id, action, next_snapshot)
    if comparison is not None:
        game["nodes"][child_id]["comparison"] = comparison
    committed = submit_reviewable_child(game, parent_id, child_id, comparison)
    if not committed:
        return

    if action_type in ("ankan", "kakan") and next_snapshot["phase"] == "game_end":
        ROUND_PROGRESSION.advance_terminal_round(game)
        return

    if action_type == "ryukyoku":
        ROUND_PROGRESSION.advance_terminal_round(game)


def submit_discard(tile, from_drawn=None):
    ensure_game_loaded()
    game = STATE["game"]
    if game.get("pendingReview"):
        finalize_pending_review(tile=tile, from_drawn=from_drawn)
        return

    current_snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
    current_node = game["nodes"][game["currentNodeId"]]
    actor = current_snapshot["currentActor"]

    if actor != STATE["controlledSeat"]:
        raise ValueError("It is not the controlled seat's turn.")
    if current_snapshot["phase"] != "discard":
        raise ValueError("The current state is not waiting for a discard.")

    next_snapshot, action = create_user_discard_child_snapshot(current_snapshot, tile, source="user", from_drawn=from_drawn)

    analysis_key = DECISION_ANALYSIS.cache_key(current_snapshot)
    comparison = None
    force_commit = current_snapshot.get("pendingRiichiSeat") == actor
    DECISION_ANALYSIS.ensure_cached(current_node, current_snapshot)
    if analysis_key in current_node["analysisCache"]:
        comparison = build_comparison_result(
            current_node["analysisCache"][analysis_key],
            tile,
            actor,
            from_drawn,
        )

    parent_id = game["currentNodeId"]
    existing_id = _find_existing_child(game, parent_id, action)
    if existing_id is not None:
        _reuse_or_review_existing_child(
            game,
            parent_id,
            existing_id,
            comparison,
            action=action,
            next_snapshot=next_snapshot,
            force_commit=force_commit,
        )
        return

    child_id = create_node(game, parent_id, action, next_snapshot)
    if comparison is not None:
        game["nodes"][child_id]["comparison"] = comparison
    committed = submit_reviewable_child(game, parent_id, child_id, comparison, force_commit=force_commit, chosen_from_drawn=from_drawn)
    if not committed:
        return


def toggle_riichi_intent():
    submit_discard_phase_special_action("reach", "declare")


def submit_riichi_discard(tile, from_drawn=None):
    ensure_game_loaded()
    game = STATE["game"]
    if game.get("pendingReview"):
        finalize_pending_review(tile=tile, from_drawn=from_drawn)
        return
    current_snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
    current_node = game["nodes"][game["currentNodeId"]]
    actor = current_snapshot["currentActor"]

    if actor != STATE["controlledSeat"]:
        raise ValueError("Not the controlled seat.")
    if current_snapshot["phase"] != "reach_declaration":
        raise ValueError("Not in reach declaration phase.")
    if tile not in current_snapshot["hands"][actor]:
        raise ValueError(f"Tile {tile} not in hand.")

    next_snapshot, action = create_user_discard_child_snapshot(current_snapshot, tile, source="user", from_drawn=from_drawn)
    analysis_key = DECISION_ANALYSIS.cache_key(current_snapshot)
    comparison = None
    DECISION_ANALYSIS.ensure_cached(current_node, current_snapshot)
    if analysis_key in current_node["analysisCache"]:
        comparison = build_comparison_result(
            current_node["analysisCache"][analysis_key],
            tile,
            actor,
            from_drawn,
        )

    parent_id = game["currentNodeId"]
    existing_id = _find_existing_child(game, parent_id, action)
    if existing_id is not None:
        _reuse_or_review_existing_child(
            game,
            parent_id,
            existing_id,
            comparison,
            action=action,
            next_snapshot=next_snapshot,
        )
        return

    child_id = create_node(game, parent_id, action, next_snapshot)
    if comparison is not None:
        game["nodes"][child_id]["comparison"] = comparison
    committed = submit_reviewable_child(game, parent_id, child_id, comparison, chosen_from_drawn=from_drawn)
    if not committed:
        return


def submit_abortive_draw(reason):
    submit_discard_phase_special_action("ryukyoku", reason)


def submit_self_hora():
    submit_discard_phase_special_action("hora", "tsumo")


def submit_self_kan(variant):
    action_type = str(variant or "").split(":", 1)[0] or "ankan"
    submit_discard_phase_special_action(action_type, variant)


def submit_riichi_ankan_skip():
    ensure_game_loaded()
    game = STATE["game"]
    parent_id = game["currentNodeId"]
    parent_node = game["nodes"][parent_id]
    parent_snapshot = parent_node["snapshot"]
    actor = int(parent_snapshot.get("currentActor", -1))
    if (
        parent_snapshot.get("phase") != "discard"
        or parent_snapshot.get("riichiDiscardState") != "ankan_choice"
        or actor != STATE["controlledSeat"]
    ):
        raise ValueError("Skip is only legal during the controlled riichi ankan choice.")
    action = next(
        (
            copy.deepcopy(candidate)
            for candidate in build_legal_actions(parent_snapshot, controlled_seat=actor)
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
    persist_snapshot_state(next_snapshot)
    child_id = create_node(game, parent_id, action, next_snapshot)

    analysis_key = DECISION_ANALYSIS.cache_key(parent_snapshot)
    DECISION_ANALYSIS.ensure_cached(parent_node, parent_snapshot)
    if analysis_key in parent_node["analysisCache"]:
        comparison = build_special_action_comparison_result(
            parent_node["analysisCache"][analysis_key],
            "none",
            actor,
            action.get("variant"),
        )
        if comparison is not None:
            game["nodes"][child_id]["comparison"] = comparison
    attach_mainline(parent_id, child_id)
    game["currentNodeId"] = child_id
    promote_path_to_mainline(game, child_id)
    GAME_FLOW.process_riichi_auto_tsumogiri(game, next_snapshot, actor)


def submit_reaction_action(action_type, variant=None, candidate_id=None):
    ensure_game_loaded()
    game = STATE["game"]
    current_snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
    current_node = game["nodes"][game["currentNodeId"]]

    if current_snapshot["phase"] not in ("reaction_window", "kan_reaction_window"):
        raise ValueError("The current state is not waiting for a reaction.")

    if game.get("pendingReview"):
        finalize_pending_review(
            action_type=action_type,
            variant=variant,
            candidate_id=candidate_id,
        )
        return

    next_snapshot, _selected, action = create_reaction_child_snapshot(
        current_snapshot,
        action_type,
        variant,
        candidate_id,
    )
    analysis_key = DECISION_ANALYSIS.cache_key(current_snapshot)
    comparison = None
    DECISION_ANALYSIS.ensure_cached(current_node, current_snapshot)
    if analysis_key in current_node["analysisCache"]:
        comparison = build_reaction_comparison_result(
            current_node["analysisCache"][analysis_key],
            action_type,
            STATE["controlledSeat"],
            variant,
            candidate_id,
        )

    parent_id = game["currentNodeId"]
    existing_id = _find_existing_child(game, parent_id, action)
    if existing_id is not None:
        _reuse_or_review_existing_child(
            game,
            parent_id,
            existing_id,
            comparison,
            action=action,
            next_snapshot=next_snapshot,
        )
        return

    child_id = create_node(game, parent_id, action, next_snapshot)
    if comparison is not None:
        game["nodes"][child_id]["comparison"] = comparison
    committed = submit_reviewable_child(game, parent_id, child_id, comparison)
    if not committed:
        return

    finalize_pending_review_advance(game, next_snapshot)


def clear_loaded_analysis_caches():
    ensure_game_loaded()
    PLAY_PREFETCH.cancel()
    game = STATE["game"]
    game_id = game.get("gameId")

    AUTO_ANALYSIS.cancel("缓存已清除")
    decision_epoch, opponent_epoch = ENGINE_MANAGEMENT.advance_cache_epochs()
    DECISION_ANALYSIS.purge(game_id)
    OPPONENT_PREDICTIONS.cancel_all()

    decision_entries = 0
    opponent_entries = 0
    comparisons = 0
    for node in game.get("nodes", {}).values():
        decision_cache = node.get("analysisCache")
        if isinstance(decision_cache, dict):
            decision_entries += len(decision_cache)
        node["analysisCache"] = {}

        opponent_cache = node.pop(OPPONENT_ANALYSIS_CACHE_FIELD, None)
        if isinstance(opponent_cache, dict):
            opponent_entries += len(opponent_cache)

        if node.get("comparison") is not None:
            comparisons += 1
            node["comparison"] = None

    had_pending_review = game.get("pendingReview") is not None
    game["pendingReview"] = None
    game[ANALYSIS_SOURCES_FIELD] = {}
    AUTO_ANALYSIS.invalidate_timeline()
    game_tree.mark_tree_changed(game)
    return {
        "decisionEntries": decision_entries,
        "decisionCacheEpoch": decision_epoch,
        "opponentCacheEpoch": opponent_epoch,
        "opponentEntries": opponent_entries,
        "comparisons": comparisons,
        "pendingReview": had_pending_review,
        "treeRevision": int(game.get("treeRevision", 0)),
    }


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
        advance_to_next_user_turn=advance_to_next_user_turn,
        prewarm_action_engine=_prewarm_record_action_engine,
        repair_reaction_decisions=repair_reaction_decision_nodes,
        backfill_child_comparisons=DECISION_ANALYSIS.backfill_child_comparisons,
        update_child_comparisons=DECISION_ANALYSIS.update_child_comparisons,
        current_snapshot=get_current_snapshot,
        request_opponent_analysis=OPPONENT_ANALYSIS.request_current,
        purge_mjai_cache=purge_stale_mjai_stream_cache,
        invalidate_auto_timeline=AUTO_ANALYSIS.invalidate_timeline,
    ),
)


RECORD_COMMANDS = record_commands.RecordCommands(
    STATE,
    record_commands.RecordCommandDependencies(
        ensure_loaded=ensure_game_loaded,
        ensure_writable=ensure_writable_game,
        round_root_for_node=resolve_round_root_id_for_node,
        collect_subtree_ids=collect_subtree_ids,
        cancel_play_prefetch=PLAY_PREFETCH.cancel,
        cancel_auto_analysis=AUTO_ANALYSIS.cancel,
        schedule_auto_reprioritization=AUTO_ANALYSIS.schedule_reprioritization,
        purge_background_analysis=DECISION_ANALYSIS.purge,
        purge_mjai_cache=purge_stale_mjai_stream_cache,
        sync_snapshot=sync_snapshot_state,
        request_opponent_analysis=OPPONENT_ANALYSIS.request_current,
        promote_mainline=promote_path_to_mainline,
        invalidate_auto_timeline=AUTO_ANALYSIS.invalidate_timeline,
    ),
)


def handle_command(request_id, command, payload):
    with _STATE_LOCK:
        payload = payload or {}
        training = ENGINE_MANAGEMENT.training_config()
        set_thinking_time_bounds(
            float(training.get("thinkingTimeMinS", 0.25)),
            float(training.get("thinkingTimeMaxS", 1.0)),
        )
        if command == "get_status":
            return build_status_response(request_id)

        if command == "start_auto_analysis":
            auto_analysis = AUTO_ANALYSIS.start()
            return build_response(request_id, command, {"autoAnalysis": auto_analysis})

        if command == "cancel_auto_analysis":
            auto_analysis = AUTO_ANALYSIS.cancel()
            return build_response(request_id, command, {"autoAnalysis": auto_analysis})

        if command == "describe_engine":
            return build_response(
                request_id,
                command,
                {"description": ENGINE_MANAGEMENT.describe(payload)},
            )

        if command == "create_game":
            RECORD_SESSION.create()
            play_prefetch = PLAY_PREFETCH.start()
            return build_response(
                request_id,
                command,
                {"playPrefetch": play_prefetch},
            )

        if command == "close_game":
            RECORD_SESSION.close()
            return build_response(request_id, command)

        if command == "import_mortal_report":
            reconstruction = RECORD_SESSION.import_mortal(
                payload.get("report"),
                payload.get("sourceUrl"),
                payload.get("sourceImportUrl"),
                bool(payload.get("reconstructWalls")),
                payload.get("seed"),
            )
            return build_response(request_id, command, {"reconstruction": reconstruction})

        if command == "import_custom_tenhou":
            reconstruction = RECORD_SESSION.import_custom(
                payload.get("input"),
                bool(payload.get("reconstructWalls")),
                payload.get("seed"),
            )
            return build_response(request_id, command, {"reconstruction": reconstruction})

        if command == "export_custom_tenhou":
            return build_response(
                request_id,
                command,
                {"customTenhou": RECORD_SESSION.export_custom()},
            )

        if run_debug_scenario(command, sys.modules[__name__]):
            return build_response(request_id, command)

        if command == "set_mode":
            ensure_game_loaded()
            next_mode = normalize_mode(payload.get("mode"))
            if next_mode == "play" and is_read_only_game():
                raise ValueError("This replay has no complete wall and cannot enter play mode.")
            PLAY_PREFETCH.cancel()
            STATE["mode"] = next_mode
            if STATE["gameLoaded"] and STATE["mode"] == "research":
                OPPONENT_ANALYSIS.request_current(get_current_snapshot())
            elif STATE["gameLoaded"] and STATE["mode"] == "play":
                PLAY_PREFETCH.start()
            return build_response(request_id, command)

        if command == "set_analysis_visibility":
            if "decisionRecommendations" in payload:
                enabled = bool(payload.get("decisionRecommendations"))
                STATE["decisionRecommendationsEnabled"] = enabled
                if not enabled:
                    DECISION_ANALYSIS.cancel_pending()
                    game = STATE.get("game")
                    if isinstance(game, dict) and game.get("pendingReview"):
                        finalize_pending_review(confirm_proposed=True)

            if "opponentAnalysis" in payload:
                enabled = bool(payload.get("opponentAnalysis"))
                STATE["opponentAnalysisEnabled"] = enabled
                if enabled and STATE.get("gameLoaded"):
                    OPPONENT_ANALYSIS.request_current(get_current_snapshot())
                elif not enabled:
                    OPPONENT_PREDICTIONS.cancel_pending()

            if STATE.get("mode") == "play" and STATE.get("gameLoaded"):
                PLAY_PREFETCH.start()
            return build_response(request_id, command)

        if command == "request_seat_switch":
            seat = normalize_seat(payload.get("seat"))
            AUTO_ANALYSIS.cancel("主视角已切换")
            PLAY_PREFETCH.cancel()
            STATE["pendingSeatSwitch"] = seat
            if STATE["gameLoaded"] and STATE["mode"] == "play":
                advance_to_next_user_turn(STATE["game"])
                normalize_current_tree_cursor(STATE["game"], STATE["controlledSeat"])
            elif STATE["mode"] != "play":
                apply_pending_seat_switch_if_ready(get_current_snapshot() if STATE["gameLoaded"] else {})
                if STATE["gameLoaded"]:
                    normalize_current_tree_cursor(STATE["game"], STATE["controlledSeat"])
                    OPPONENT_ANALYSIS.request_current(get_current_snapshot())
            elif STATE["gameLoaded"]:
                PLAY_PREFETCH.start()
            return build_response(request_id, command)

        if command == "toggle_visible_hands":
            STATE["visibleHands"] = not STATE["visibleHands"]
            if STATE["gameLoaded"] and STATE["mode"] == "research":
                OPPONENT_ANALYSIS.request_current(get_current_snapshot())
            return build_response(request_id, command)

        if command == "get_game_view":
            return build_response(request_id, command)

        if command == "advance_game":
            ensure_play_mode()
            if STATE["game"].get("pendingReview"):
                return build_response(request_id, command)
            play_prefetch = PLAY_PREFETCH.advance_game(STATE["game"])
            # Trigger asynchronous opponent analysis in research mode.
            if STATE.get("gameLoaded") and STATE.get("mode") == "research":
                snapshot = get_current_snapshot()
                OPPONENT_ANALYSIS.request_current(snapshot)
            response = build_response(
                request_id,
                command,
                {"playPrefetch": play_prefetch},
            )
            return response

        if command == "export_game_record":
            if payload.get("checkpoint") is True:
                return {
                    "request_id": request_id,
                    "command": command,
                    "record": RECORD_SESSION.serialize(),
                    "state": {
                        "analysisVisibility": {
                            "decisionRecommendations": bool(STATE.get("decisionRecommendationsEnabled", True)),
                            "opponentAnalysis": bool(STATE.get("opponentAnalysisEnabled", False)),
                        },
                    },
                }
            return build_response(
                request_id,
                command,
                {
                    "record": RECORD_SESSION.serialize(),
                },
            )

        if command == "import_game_record":
            RECORD_SESSION.load(payload.get("record"))
            return build_response(request_id, command)

        if command == "jump_to_node":
            stayed_in_round = RECORD_COMMANDS.jump(str(payload.get("nodeId") or ""))
            try:
                client_tree_revision = int(payload.get("treeRevision"))
            except (TypeError, ValueError):
                client_tree_revision = None
            tree_is_current = client_tree_revision == int(STATE["game"].get("treeRevision", 0))
            return build_response(request_id, command, compact_tree=stayed_in_round and tree_is_current)

        if command == "set_main_branch":
            RECORD_COMMANDS.set_main_branch(str(payload.get("nodeId") or ""))
            return build_response(request_id, command)

        if command == "set_node_comment":
            node_id = str(payload.get("nodeId") or "")
            changed, comment = RECORD_COMMANDS.set_comment(node_id, payload.get("comment"))
            return {
                "request_id": request_id,
                "command": command,
                "nodeId": node_id,
                "comment": comment,
                "changed": changed,
                "timestamp": now_iso(),
            }

        if command == "delete_node":
            deleted_count = RECORD_COMMANDS.delete(str(payload.get("nodeId") or ""))
            return build_response(request_id, command, {"deletedCount": deleted_count})

        if command == "submit_user_action":
            ensure_play_mode()
            PLAY_PREFETCH.cancel()
            action_type = payload.get("type")
            game = STATE["game"]
            if not game:
                raise ValueError("No active game.")
            current_snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]

            if current_snapshot["phase"] == "discard":
                if action_type == "dahai":
                    submit_discard(str(payload.get("pai") or ""), payload.get("fromDrawn"))
                elif action_type == "hora":
                    submit_self_hora()
                elif action_type in ("ankan", "kakan"):
                    submit_self_kan(str(payload.get("variant") or action_type))
                elif action_type == "reach":
                    toggle_riichi_intent()
                elif action_type == "ryukyoku":
                    submit_abortive_draw(str(payload.get("variant") or ""))
                elif action_type == "none":
                    if current_snapshot.get("riichiDiscardState") == "ankan_choice":
                        submit_riichi_ankan_skip()
                    else:
                        raise ValueError("Skip is only legal during riichi ankan choice.")
                else:
                    raise ValueError(f"Unsupported discard-phase action type: {action_type}")
            elif current_snapshot["phase"] == "reach_declaration":
                if action_type == "dahai":
                    submit_riichi_discard(str(payload.get("pai") or ""), payload.get("fromDrawn"))
                else:
                    raise ValueError(f"Unsupported reach-declaration-phase action type: {action_type}")
            elif current_snapshot["phase"] in ("reaction_window", "kan_reaction_window"):
                if action_type == "dahai":
                    return build_response(request_id, command)
                submit_reaction_action(
                    str(action_type or ""),
                    str(payload.get("variant") or "") or None,
                    str(payload.get("candidateId") or "") or None,
                )
            else:
                raise ValueError(f"Unsupported action phase for submit_user_action: {current_snapshot['phase']}")
            play_prefetch = PLAY_PREFETCH.start()
            return build_response(
                request_id,
                command,
                {"playPrefetch": play_prefetch},
            )

        if command == "confirm_pending_review":
            ensure_play_mode()
            PLAY_PREFETCH.cancel()
            finalize_pending_review(confirm_proposed=True)
            play_prefetch = PLAY_PREFETCH.start()
            return build_response(
                request_id,
                command,
                {"playPrefetch": play_prefetch},
            )

        if command == "get_wall_view":
            ensure_game_loaded()
            game = STATE["game"]
            snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
            metadata = game.get("metadata") or {}
            tiles = get_wall_view(snapshot)
            reconstruction = metadata.get("wallReconstruction") or {}
            return {
                "request_id": request_id,
                "command": command,
                "tiles": tiles,
                "complete": len(tiles) == 136,
                "canReconstruct": bool(
                    metadata.get("source") in ("mortal-report", "tenhou-custom")
                    and metadata.get("readOnly")
                ),
                "seed": reconstruction.get("seed") if reconstruction else (
                    game.get("seed") if len(tiles) == 136 else None
                ),
                "origin": str(snapshot.get("wallOrigin") or (
                    "reconstructed" if reconstruction else "generated"
                )),
                "sourceUrl": metadata.get("sourceImportUrl") or metadata.get("sourceUrl"),
                "timestamp": now_iso(),
            }

        if command == "reconstruct_walls":
            reconstruction = RECORD_SESSION.reconstruct_walls(payload.get("seed"))
            return build_response(request_id, command, {"reconstruction": reconstruction})

        if command == "import_wall":
            ensure_writable_game()
            tiles = payload.get("tiles")
            reset_current_round_with_full_wall(tiles)
            return build_response(request_id, command)

        if command == "get_latest_mjai_debug":
            return build_response(request_id, command, {"debug": get_latest_action_recommendation_debug()})

        if command == "get_shanten":
            return build_response(request_id, command, OPPONENT_ANALYSIS.current())

        if command == "get_shanten_mjai":
            return build_response(request_id, command, {"debug": get_latest_opponent_prediction_mjai()})

        if command == "clear_analysis_caches":
            cleared = clear_loaded_analysis_caches()
            return {
                "request_id": request_id,
                "command": command,
                "state": build_state_payload(),
                "cleared": cleared,
                "timestamp": now_iso(),
            }

        raise ValueError(f"Unsupported command: {command}")


def process_command_request(request_id, command, payload, *, lightweight_status=False):
    try:
        if lightweight_status:
            response = build_status_response(request_id)
        elif command == "get_runtime_metrics":
            response = {
                "request_id": request_id,
                "command": command,
                "metrics": build_runtime_memory_metrics(),
                "timestamp": now_iso(),
            }
        elif command == "describe_engine":
            response = {
                "request_id": request_id,
                "command": command,
                "description": ENGINE_MANAGEMENT.describe(payload or {}),
                "timestamp": now_iso(),
            }
        elif command == "reload_engines":
            result = ENGINE_MANAGEMENT.reload(
                str((payload or {}).get("profileId") or "")
            )
            with _STATE_LOCK:
                response = build_response(
                    request_id,
                    command,
                    {"reload": result},
                )
        elif command == "unload_engine":
            response = {
                "request_id": request_id,
                "command": command,
                "state": ENGINE_MANAGEMENT.unload(
                    (payload or {}).get("kind"),
                    (payload or {}).get("profileId"),
                ),
                "timestamp": now_iso(),
            }
        else:
            response = handle_command(request_id, command, payload)
        emit(response)
    except Exception as error:  # pylint: disable=broad-except
        emit(
            {
                "request_id": request_id,
                "command": command,
                "error": str(error),
                "timestamp": now_iso(),
            }
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
                process_command_request,
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
