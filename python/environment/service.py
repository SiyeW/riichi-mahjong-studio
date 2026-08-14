import copy
import json
import os
import random
import re
import sys
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from itertools import combinations, product
from pathlib import Path

try:
    import psutil
except ModuleNotFoundError:
    psutil = None

import auto_analysis_plan
from auto_analysis_runtime import AutoAnalysisRuntime
import game_tree
from action_recommendation_adapter import (
    analyze_action_choices,
    analyze_discard_choices,
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
    build_analysis_source,
    cache_key_context,
    compact_opponent_analysis,
    decision_cache_key,
    find_stale_cache_entry,
    migrate_analysis_cache_storage,
    opponent_analysis_cache_key,
    prune_stale_cache_entries,
    register_analysis_source,
    same_analysis_context,
)
from engine_assignments import profiles_by_output, resolve_engine_assignments
from engine_runtime import EngineRuntimeRegistry
from game_record_storage import (
    RECORD_FORMAT_VERSION,
    hydrate_game_structure,
    hydrate_round_walls,
    repair_tsumo_action_tiles,
    serialize_game_record_parts,
)
from match_progression import apply_round_result_to_match_state, get_round_seed
from opponent_prediction_coordinator import OpponentPredictionCoordinator
from opponent_prediction_gateway import get_latest_opponent_prediction_mjai
from mjai_stream import build_mjai_events_from_actions, build_mjai_stream
from mortal_report_import import attach_mortal_review_cache, build_mortal_report_game, repair_mortal_report_game
from custom_tenhou import (
    build_custom_tenhou_game,
    export_custom_tenhou,
    normalize_custom_tenhou_input,
)
from wall_reconstruction import reconstruct_imported_walls
from service_debug import run_debug_scenario
from service_helpers import (
    DORA_INDICATOR_POSITIONS,
    HONOR_TILES,
    RINSHAN_DRAW_POSITIONS,
    SEAT_LABELS,
    SUIT_TILES,
    URA_INDICATOR_POSITIONS,
    actor_just_drew,
    build_comparison_result,
    build_special_action_comparison_result,
    build_reaction_comparison_result,
    build_round_seed_stream,
    build_wall,
    get_forbidden_discard_families_after_self_furo,
    get_reaction_expected_hand_count,
    get_reaction_hand_consumed,
    resolve_reaction_hand_consumed,
    get_abortive_reason_label,
    normalize_tile_family,
    now_iso,
    sort_tiles,
    unique_preserving_order,
)
from settlement import (
    can_ankan,
    can_declare_ron,
    can_declare_riichi,
    compute_hora_result,
    can_declare_ryukyoku,
    can_declare_tsumo,
    count_yaochu_kinds,
    compute_abortive_ryukyoku,
    compute_exhaustive_ryukyoku,
    build_player_state,
    get_ankan_candidates,
    get_valid_riichi_discards,
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
_PLAY_PREFETCH_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_ENGINE_PREWARM_EXECUTOR = ThreadPoolExecutor(max_workers=2)
_COMMAND_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_STATUS_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_METRICS_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_ENGINE_INSPECTION_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_ENGINE_RELOAD_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_BG_TASKS = {}
_BG_COMPLETED = set()
_DECISION_CACHE_EPOCH = 0
_OPPONENT_ANALYSIS_CACHE_EPOCH = 0
_ACTIVE_DECISION_SOURCE_ID = None
_ACTIVE_OPPONENT_ANALYSIS_SOURCE_ID = None
_EMIT_LOCK = threading.Lock()
_STATE_LOCK = threading.RLock()
_PLAY_PREFETCH_LOCK = threading.RLock()
_PLAY_PREFETCH_LOCAL = threading.local()
_PLAY_PREFETCH_GENERATION = 0
_PLAY_PREFETCH_CONTEXT = None
_PROJECT_CONFIG_LOCK = threading.Lock()
_ENGINE_CONFIG_LOCK = threading.Lock()
_PROJECT_CONFIG_SIGNATURE = None
_PROJECT_CONFIG_VALUE = {}
_RUNTIME_ENGINE_SETTINGS = None
_MJAI_STREAM_CACHE = {}
_MJAI_STREAM_CACHE_MAX = 64
_LEGAL_ACTIONS_CACHE = {}
_LEGAL_ACTIONS_CACHE_MAX = 4096
_MJAI_HASH_MASK = (1 << 64) - 1
_MJAI_HASH_MULTIPLIER = 1000003
AUTO_ANALYSIS_RUNTIME = AutoAnalysisRuntime()
DEBUG_FLOW = os.environ.get("MJAI_FLOW_DEBUG", "").lower() in ("1", "true", "yes", "on")
def debug_flow(message):
    if DEBUG_FLOW:
        print(message, file=sys.stderr)


def prewarm_runtime(profile_id=""):
    requested_profile_id = str(profile_id or "")
    action_weight_path = get_action_engine_weight_path()
    warmed = {
        "teachingAnalysis": False,
        "teachingPlay": False,
        "opponentPlay": False,
        "opponentAnalysis": False,
    }
    errors = {}
    decision_profile_id = str(
        ACTION_RECOMMENDATIONS.runtime_status().get("profileId") or ""
    )
    opponent_profile_ids = set(
        OPPONENT_PREDICTIONS.runtime_status().get("profileIds") or []
    )
    prewarm_decision = bool(decision_profile_id) and (
        not requested_profile_id or decision_profile_id == requested_profile_id
    )
    prewarm_opponent = bool(opponent_profile_ids) and (
        not requested_profile_id or requested_profile_id in opponent_profile_ids
    )

    def _prewarm_decision():
        if not ACTION_RECOMMENDATIONS.runtime_status().get("profileId"):
            return False, None
        try:
            ready = ACTION_RECOMMENDATIONS.prewarm(0, action_weight_path)
            error = (
                None
                if ready
                else ACTION_RECOMMENDATIONS.activity_error() or "决策引擎预热失败"
            )
            return ready, error
        except Exception as error:
            return False, str(error)
        finally:
            _emit_decision_activity(
                ACTION_RECOMMENDATIONS.active_seat(),
                ACTION_RECOMMENDATIONS.activity_state(),
                ACTION_RECOMMENDATIONS.activity_error(),
            )

    def _prewarm_opponent_analysis():
        if not OPPONENT_PREDICTIONS.runtime_status().get("profileId"):
            return False, None
        try:
            ready = OPPONENT_PREDICTIONS.prewarm(requested_profile_id or None)
            error = (
                None
                if ready
                else OPPONENT_PREDICTIONS.activity_error() or "对手分析引擎预热失败"
            )
            return ready, error
        except Exception as error:
            return False, str(error)
        finally:
            _emit_opponent_analysis_activity(
                OPPONENT_PREDICTIONS.activity_state(),
                OPPONENT_PREDICTIONS.activity_error(),
            )

    decision_future = (
        _ENGINE_PREWARM_EXECUTOR.submit(_prewarm_decision)
        if prewarm_decision
        else None
    )
    opponent_future = (
        _ENGINE_PREWARM_EXECUTOR.submit(_prewarm_opponent_analysis)
        if prewarm_opponent
        else None
    )
    decision_ready, decision_error = (
        decision_future.result() if decision_future else (False, None)
    )
    opponent_ready, opponent_error = (
        opponent_future.result() if opponent_future else (False, None)
    )

    warmed["teachingAnalysis"] = decision_ready
    warmed["teachingPlay"] = decision_ready
    warmed["opponentPlay"] = decision_ready
    warmed["opponentAnalysis"] = opponent_ready
    if decision_error:
        errors["decision"] = decision_error
    if opponent_error:
        errors["opponent-analysis"] = opponent_error
    return {
        "warmed": warmed,
        "device": ACTION_RECOMMENDATIONS.device_str,
        "errors": errors,
    }

def _load_json_file(path):
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def _project_config_paths():
    configured_path = str(os.environ.get("MJAI_TRAINER_CONFIG") or "").strip()
    if configured_path:
        return (Path(configured_path).expanduser().resolve(),)
    if getattr(sys, "frozen", False):
        return (
            Path(sys.executable).resolve().parent / "config.json",
            PORTABLE_ROOT / "config.json",
        )
    return (PROJECT_ROOT / "config.json",)


def load_project_config():
    global _PROJECT_CONFIG_SIGNATURE, _PROJECT_CONFIG_VALUE

    paths = _project_config_paths()
    signature = []
    for path in paths:
        try:
            stat = path.stat()
            signature.append((str(path), stat.st_mtime_ns, stat.st_size))
        except OSError:
            signature.append((str(path), None, None))
    signature = tuple(signature)

    with _PROJECT_CONFIG_LOCK:
        if signature == _PROJECT_CONFIG_SIGNATURE:
            return _PROJECT_CONFIG_VALUE

        base = _load_json_file(paths[0])
        if len(paths) > 1:
            user = _load_json_file(paths[1])
            for key in (
                "training",
                "modeDefaults",
                "audio",
                "engines",
            ):
                if key in user:
                    base[key] = user[key]
        _PROJECT_CONFIG_SIGNATURE = signature
        _PROJECT_CONFIG_VALUE = base
        return _PROJECT_CONFIG_VALUE


_DECISION_POSTPROCESSOR_VERSION = "decision-analysis-v2"
_NODE_COMMENT_MAX_LENGTH = 20_000


def _analysis_source_display_name(kind):
    config = load_project_config()
    output_ids = (
        {"action-recommendation"}
        if kind == "decision"
        else {"opponent-shanten", "opponent-deal-in-probability"}
    )
    names = []
    for assignment in resolve_engine_assignments(config):
        if not output_ids.intersection(assignment["outputs"]):
            continue
        profile = assignment["profile"]
        name = str(
            profile.get("name")
            or profile.get("engineId")
            or assignment["profileId"]
        )
        if name and name not in names:
            names.append(name)
    return " + ".join(names) or str(kind)


def _current_decision_analysis_source(model_path=None, *, include_display_name=False):
    return build_analysis_source(
        "decision",
        ACTION_RECOMMENDATIONS.cache_identity(model_path),
        _DECISION_POSTPROCESSOR_VERSION,
        "action-recommendation@1",
        display_name=(
            _analysis_source_display_name("decision")
            if include_display_name
            else "决策引擎"
        ),
    )


def _current_opponent_analysis_source(*, include_display_name=False):
    return build_analysis_source(
        "opponent",
        OPPONENT_PREDICTIONS.cache_identity(),
        None,
        "opponent-shanten@1+opponent-deal-in-probability@1",
        display_name=(
            _analysis_source_display_name("opponent")
            if include_display_name
            else "Opponent analysis"
        ),
    )


def _migrate_discard_tsumogiri(game):
    """Restore discard identity fields omitted by older AI-generated nodes."""
    if not isinstance(game, dict):
        return
    for node in game.get("nodes", {}).values():
        action = node.get("action") if isinstance(node, dict) else None
        if not isinstance(action, dict) or action.get("type") != "dahai" or "tsumogiri" in action:
            continue
        snapshot = node.get("snapshot") or {}
        last_action = snapshot.get("lastAction") or {}
        if (
            last_action.get("type") == "dahai"
            and last_action.get("actor") == action.get("actor")
            and str(last_action.get("pai") or "") == str(action.get("pai") or "")
            and isinstance(last_action.get("tsumogiri"), bool)
        ):
            action["tsumogiri"] = last_action["tsumogiri"]


def _migrate_terminal_table_scores(game):
    """Keep settlement deltas out of the table until the next round starts."""
    if not isinstance(game, dict):
        return
    nodes = game.get("nodes") or {}

    def score_list(value):
        if not isinstance(value, (list, tuple)) or len(value) != 4:
            return None
        try:
            return [int(score) for score in value]
        except (TypeError, ValueError):
            return None

    def set_table_scores(snapshot, scores):
        snapshot["scores"] = copy.deepcopy(scores)
        match_state = snapshot.get("matchState")
        if isinstance(match_state, dict):
            match_state["scores"] = copy.deepcopy(scores)

    for node in nodes.values():
        action = node.get("action") if isinstance(node, dict) else None
        if not isinstance(action, dict) or action.get("type") != "round_result":
            continue

        terminal_nodes = []
        cursor = nodes.get(node.get("parentId"))
        while isinstance(cursor, dict) and (cursor.get("action") or {}).get("type") in ("hora", "ryukyoku"):
            terminal_nodes.append(cursor)
            cursor = nodes.get(cursor.get("parentId"))
        if not terminal_nodes or not isinstance(cursor, dict):
            continue
        base_scores = score_list((cursor.get("snapshot") or {}).get("scores"))
        if base_scores is None:
            continue

        snapshot = node.get("snapshot") or {}
        result_payloads = []
        action_result = action.get("result")
        if isinstance(action_result, dict):
            result_payloads.append(action_result)
        last_result = (snapshot.get("lastAction") or {}).get("result")
        if isinstance(last_result, dict):
            result_payloads.append(last_result)

        settled_scores = next((
            scores
            for scores in (score_list(result.get("scores")) for result in result_payloads)
            if scores is not None
        ), None)
        if settled_scores is None:
            deltas = None
            for result in result_payloads:
                event_data = result.get("eventData") or {}
                deltas = score_list(event_data.get("deltas") or result.get("deltas"))
                if deltas is not None:
                    break
            if deltas is None:
                deltas = [0, 0, 0, 0]
                for terminal_node in terminal_nodes:
                    terminal_last = (terminal_node.get("snapshot") or {}).get("lastAction") or {}
                    terminal_deltas = score_list(terminal_last.get("deltas")) or [0, 0, 0, 0]
                    deltas = [deltas[seat] + terminal_deltas[seat] for seat in range(4)]
            settled_scores = [base_scores[seat] + deltas[seat] for seat in range(4)]

        for result in result_payloads:
            result["scores"] = copy.deepcopy(settled_scores)
        for terminal_node in terminal_nodes:
            set_table_scores(terminal_node.get("snapshot") or {}, base_scores)
        set_table_scores(snapshot, base_scores)


def _get_opponent_analysis_cache_key(seat=None):
    resolved_seat = STATE["controlledSeat"] if seat is None else int(seat)
    input_mode = _get_opponent_analysis_input_mode()
    return _build_opponent_analysis_cache_key(resolved_seat, input_mode)


def _build_opponent_analysis_cache_key(seat, input_mode):
    return opponent_analysis_cache_key(
        seat,
        input_mode,
        _current_opponent_analysis_source(),
    )


def _get_opponent_analysis_input_mode():
    supported = set(OPPONENT_PREDICTIONS.supported_input_modes())
    if STATE.get("visibleHands") and "full-information" in supported:
        return "full-information"
    return "public"


def _current_opponent_analysis_context():
    game = STATE.get("game")
    if not STATE.get("gameLoaded") or not isinstance(game, dict):
        return None
    node_id = game.get("currentNodeId")
    if node_id not in game.get("nodes", {}):
        return None
    seat = int(STATE["controlledSeat"])
    input_mode = _get_opponent_analysis_input_mode()
    return {
        "gameId": game.get("gameId"),
        "nodeId": node_id,
        "seat": seat,
        "inputMode": input_mode,
        "cacheKey": _get_opponent_analysis_cache_key(seat),
        "cacheEpoch": _OPPONENT_ANALYSIS_CACHE_EPOCH,
    }


def _cache_opponent_analysis_result(result, *, require_current):
    context = result.get("context") if isinstance(result, dict) else None
    if not isinstance(context, dict) or result.get("status") != "ready":
        return False
    if context.get("cacheEpoch") != _OPPONENT_ANALYSIS_CACHE_EPOCH:
        return False

    compact = compact_opponent_analysis(result)
    changed = False
    is_current = False
    seat = int(context.get("seat", -1))
    with _STATE_LOCK:
        is_current = same_analysis_context(context, _current_opponent_analysis_context())
        if require_current and not is_current:
            return False
        game = STATE.get("game")
        if not isinstance(game, dict) or game.get("gameId") != context.get("gameId"):
            return False
        node = game.get("nodes", {}).get(context.get("nodeId"))
        cache_key = str(context.get("cacheKey") or "")
        if not isinstance(node, dict) or not cache_key or cache_key != _get_opponent_analysis_cache_key(seat):
            return False

        source = _current_opponent_analysis_source(include_display_name=True)
        register_analysis_source(game, source, result)
        cache = node.setdefault(OPPONENT_ANALYSIS_CACHE_FIELD, {})
        prune_stale_cache_entries(cache, cache_key)
        if cache.get(cache_key) != compact:
            cache[cache_key] = compact
            changed = True

    if changed:
        _set_auto_analysis_timeline_cached("opponent", context.get("nodeId"), True)
        emit({
            "type": "record_changed",
            "gameId": context.get("gameId"),
            "change": "opponent_analysis_cache",
            "timestamp": now_iso(),
        })
    if is_current and STATE.get("opponentAnalysisEnabled"):
        emit({
            "type": "opponent_analysis_ready",
            "gameId": context.get("gameId"),
            "nodeId": context.get("nodeId"),
            "seat": seat,
            "opponentAnalysis": attach_analysis_context(compact, context),
            "autoAnalysis": get_auto_analysis_status(
                include_timeline=STATE.get("mode") == "research"
            ),
            "timestamp": now_iso(),
        })
    return True


def _store_opponent_analysis_result(result):
    _cache_opponent_analysis_result(result, require_current=True)


def request_current_opponent_analysis(snapshot=None):
    with _STATE_LOCK:
        if not STATE.get("opponentAnalysisEnabled"):
            return False
        context = _current_opponent_analysis_context()
        if context is None:
            return False
        OPPONENT_PREDICTIONS.set_latest_context(context)
        game = STATE["game"]
        node = game["nodes"][context["nodeId"]]
        if context["cacheKey"] in node.get(OPPONENT_ANALYSIS_CACHE_FIELD, {}):
            return False
        if play_prefetch_owns_opponent(context["nodeId"]):
            return False
        if OPPONENT_PREDICTIONS.has_request(context):
            return False
        if auto_analysis_owns_item("opponent", context["nodeId"]):
            return False
        input_mode = context["inputMode"]
        prediction_bundle = get_cached_mjai_stream_bundle(
            game,
            context["nodeId"],
            context["seat"],
            reveal_all=input_mode == "full-information",
        )
        target_bundle = get_cached_mjai_stream_bundle(
            game,
            context["nodeId"],
            context["seat"],
            reveal_all=True,
        )
        OPPONENT_PREDICTIONS.request_predict(
            snapshot if snapshot is not None else node["snapshot"],
            context["seat"],
            STATE["visibleHands"],
            input_mode=input_mode,
            context=context,
            on_complete=_store_opponent_analysis_result,
            mjai_events=prediction_bundle["events"],
            mjai_prefix_hashes=prediction_bundle["prefixHashes"],
            mjai_events_hash=prediction_bundle["eventHash"],
            target_mjai_events=target_bundle["events"],
            target_mjai_prefix_hashes=target_bundle["prefixHashes"],
            target_mjai_events_hash=target_bundle["eventHash"],
        )
        return True


def get_current_opponent_analysis():
    if not STATE.get("opponentAnalysisEnabled"):
        return {"status": "disabled", "predictions": {}, "ground_truth": {}}
    context = _current_opponent_analysis_context()
    if context is None:
        return {"status": "unavailable", "predictions": {}, "ground_truth": {}}

    latest = OPPONENT_PREDICTIONS.get_latest()
    latest_context = latest.get("context") if isinstance(latest, dict) else None
    if same_analysis_context(latest_context, context) and latest.get("status") == "ready":
        return latest

    node = STATE["game"]["nodes"][context["nodeId"]]
    cached = node.get(OPPONENT_ANALYSIS_CACHE_FIELD, {}).get(context["cacheKey"])
    if isinstance(cached, dict):
        return attach_analysis_context(cached, context)

    stale = find_stale_cache_entry(
        STATE["game"],
        node,
        context["cacheKey"],
        OPPONENT_ANALYSIS_CACHE_FIELD,
    )
    if same_analysis_context(latest_context, context):
        if isinstance(stale, dict):
            return attach_analysis_context(stale, context)
        return latest

    request_current_opponent_analysis(node["snapshot"])
    if isinstance(stale, dict):
        return attach_analysis_context(stale, context)
    latest = OPPONENT_PREDICTIONS.get_latest()
    latest_context = latest.get("context") if isinstance(latest, dict) else None
    if same_analysis_context(latest_context, context):
        return latest
    return {
        "status": "loading",
        "predictions": {"opponents": {}, "ron_wait": {}},
        "ground_truth": {"opponents": {}, "ron_wait": {}},
        "context": copy.deepcopy(context),
    }


def _runtime_engine_config():
    if isinstance(_RUNTIME_ENGINE_SETTINGS, dict):
        return {"engines": _RUNTIME_ENGINE_SETTINGS}
    return load_project_config()


def _assigned_engine_profile(config, output_id):
    return profiles_by_output(config).get(str(output_id or ""))


def normalize_training_mode(mode):
    return {
        "no_review": "no_review",
        "free_play": "preview_before_click",
        "guided": "threshold_review",
        "strict": "always_review",
    }.get(str(mode or ""), str(mode or "threshold_review")) or "threshold_review"


def get_default_training_config():
    return {
        "mode": "threshold_review",
        "mistakeThreshold": 0.25,
        "thinkingTimeMinS": 0.25,
        "thinkingTimeMaxS": 1.0,
    }


def get_training_config():
    config = load_project_config()
    training = config.get("training") if isinstance(config, dict) else None
    defaults = get_default_training_config()
    if not isinstance(training, dict):
        return defaults
    merged = {
        **defaults,
        **training,
    }
    merged["mode"] = normalize_training_mode(merged.get("mode"))
    try:
        merged["mistakeThreshold"] = float(merged.get("mistakeThreshold", defaults["mistakeThreshold"]))
    except (TypeError, ValueError):
        merged["mistakeThreshold"] = defaults["mistakeThreshold"]
    return merged


def get_action_engine_weight_path():
    profile = _assigned_engine_profile(
        _runtime_engine_config(),
        "action-recommendation",
    )
    weights = profile.get("weights") if isinstance(profile, dict) else None
    weights = weights if isinstance(weights, list) else []
    weight = next(
        (
            item
            for item in weights
            if isinstance(item, dict) and str(item.get("slotId") or "") == "model"
        ),
        next((item for item in weights if isinstance(item, dict)), {}),
    )
    return _resolve_engine_resource_path(weight.get("path") or "")


def _resolve_engine_resource_path(path_value):
    raw_value = str(path_value or "")
    if not raw_value:
        return ""
    path = Path(raw_value)
    if path.is_absolute():
        return str(path)
    if getattr(sys, "frozen", False) and path.parts and path.parts[0].lower() == "engines":
        return str(Path(sys.executable).resolve().parents[2] / path)
    return str(Path(__file__).resolve().parents[2] / path)


def _resolve_configured_engine_command(selected):
    raw_command = selected.get("engineCommand")
    if isinstance(raw_command, list) and raw_command and str(raw_command[0] or ""):
        return [
            _resolve_engine_resource_path(part) if index == 0 else str(part)
            for index, part in enumerate(raw_command)
        ]

    engine_path = str(selected.get("enginePath") or "")
    if engine_path:
        return [_resolve_engine_resource_path(engine_path)]

    return []


def _resolve_configured_engine_cwd(selected, command):
    configured_cwd = str(selected.get("engineCwd") or "")
    if configured_cwd:
        return _resolve_engine_resource_path(configured_cwd)
    return str(Path(command[0]).resolve().parent) if command else None


def _gateway_profile(config, output_id):
    profile = _assigned_engine_profile(config, output_id)
    if not isinstance(profile, dict):
        return None
    weights = [
        {
            "slotId": str(weight.get("slotId") or ""),
            "format": str(weight.get("format") or ""),
            "path": _resolve_engine_resource_path(weight.get("path") or ""),
        }
        for weight in (profile.get("weights") or [])
        if isinstance(weight, dict)
    ]
    primary_weight = next(
        (weight for weight in weights if weight["slotId"] == "model"),
        weights[0] if weights else {},
    )
    profile_options = profile.get("options")
    options = copy.deepcopy(profile_options) if isinstance(profile_options, dict) else {}
    if profile.get("device"):
        options["device"] = str(profile.get("device"))
    engine_command = _resolve_configured_engine_command(profile)
    return {
        "profile_id": str(profile.get("id") or ""),
        "engine_id": str(profile.get("engineId") or ""),
        "engine_version": str(profile.get("engineVersion") or ""),
        "model_id": "",
        "model_format": str(primary_weight.get("format") or ""),
        "model_path": str(primary_weight.get("path") or ""),
        "weights": weights,
        "expected_sha256": "",
        "engine_command": engine_command,
        "engine_cwd": _resolve_configured_engine_cwd(profile, engine_command),
        "engine_options": options,
    }


def _engine_runtime_specifications(config):
    specifications = []
    for assignment in resolve_engine_assignments(config):
        output_ids = assignment["outputs"]
        selected = _gateway_profile(config, output_ids[0]) if output_ids else None
        if not selected:
            continue
        options = dict(selected["engine_options"])
        device_preference = str(options.pop("device", "auto") or "auto")
        specifications.append({
            "profile_id": selected["profile_id"],
            "engine_id": selected["engine_id"],
            "engine_version": selected["engine_version"],
            "command": selected["engine_command"],
            "cwd": selected["engine_cwd"],
            "enabled_outputs": [
                {"id": output_id, "version": 1}
                for output_id in output_ids
            ],
            "weights": selected["weights"],
            "device_preference": device_preference,
            "options": options,
        })
    return specifications


def configure_action_recommendation_engine(config):
    selected = _gateway_profile(config, "action-recommendation") or {}
    engine_client = ENGINE_RUNTIME_REGISTRY.get(selected.get("profile_id"))
    ACTION_RECOMMENDATIONS.configure_profile(
        profile_id=str(selected.get("profile_id") or ""),
        engine_id=str(selected.get("engine_id") or ""),
        engine_version=str(selected.get("engine_version") or ""),
        model_id=str(selected.get("model_id") or ""),
        model_format=str(selected.get("model_format") or ""),
        expected_sha256=str(selected.get("expected_sha256") or ""),
        model_path=str(selected.get("model_path") or "") or None,
        weights=selected.get("weights") or [],
        engine_command=selected.get("engine_command") or [],
        engine_cwd=selected.get("engine_cwd"),
        engine_options=selected.get("engine_options") or {},
        engine_client=engine_client,
    )


def configure_opponent_prediction_engines(config):
    opponent_profile = _gateway_profile(config, "opponent-shanten")
    deal_in = _gateway_profile(config, "opponent-deal-in-probability")
    if opponent_profile:
        opponent_profile["input_modes"] = ["public"]
        opponent_profile["engine_client"] = ENGINE_RUNTIME_REGISTRY.get(opponent_profile["profile_id"])
    if deal_in:
        deal_in["input_modes"] = ["public"]
        deal_in["engine_client"] = ENGINE_RUNTIME_REGISTRY.get(deal_in["profile_id"])
    OPPONENT_PREDICTIONS.configure_profiles(
        opponent_profile,
        deal_in,
    )


def apply_runtime_engine_config(config=None, *, invalidate=False):
    global _ACTIVE_DECISION_SOURCE_ID, _ACTIVE_OPPONENT_ANALYSIS_SOURCE_ID
    global _DECISION_CACHE_EPOCH, _OPPONENT_ANALYSIS_CACHE_EPOCH
    global _RUNTIME_ENGINE_SETTINGS

    with _ENGINE_CONFIG_LOCK:
        config = config if isinstance(config, dict) else load_project_config()
        ENGINE_RUNTIME_REGISTRY.reconcile(_engine_runtime_specifications(config))
        configure_action_recommendation_engine(config)
        configure_opponent_prediction_engines(config)

        engines = config.get("engines") if isinstance(config, dict) else None
        _RUNTIME_ENGINE_SETTINGS = copy.deepcopy(engines) if isinstance(engines, dict) else {}

        decision_source_id = _current_decision_analysis_source()["id"]
        opponent_source_id = _current_opponent_analysis_source()["id"]
        source_changed = (
            _ACTIVE_DECISION_SOURCE_ID is not None
            and _ACTIVE_DECISION_SOURCE_ID != decision_source_id
        ) or (
            _ACTIVE_OPPONENT_ANALYSIS_SOURCE_ID is not None
            and _ACTIVE_OPPONENT_ANALYSIS_SOURCE_ID != opponent_source_id
        )
        _ACTIVE_DECISION_SOURCE_ID = decision_source_id
        _ACTIVE_OPPONENT_ANALYSIS_SOURCE_ID = opponent_source_id

    if invalidate and source_changed:
        with _STATE_LOCK:
            cancel_auto_analysis("分析模型已更改")
            cancel_play_prefetch()
            _DECISION_CACHE_EPOCH += 1
            _OPPONENT_ANALYSIS_CACHE_EPOCH += 1
            active_game = STATE.get("game")
            purge_bg_analysis_tasks(
                active_game.get("gameId") if isinstance(active_game, dict) else None
            )
            OPPONENT_PREDICTIONS.cancel_all()
            _invalidate_auto_analysis_timeline()
    return source_changed


def reload_runtime_engines(profile_id):
    requested_profile_id = str(profile_id or "")
    if not requested_profile_id:
        raise ValueError("engine profile id is required")
    apply_runtime_engine_config(load_project_config(), invalidate=True)
    matched = False
    if (
        str(ACTION_RECOMMENDATIONS.runtime_status().get("profileId") or "")
        == requested_profile_id
    ):
        ACTION_RECOMMENDATIONS.prepare_reload()
        matched = True
    if requested_profile_id in set(
        OPPONENT_PREDICTIONS.runtime_status().get("profileIds") or []
    ):
        OPPONENT_PREDICTIONS.prepare_reload(requested_profile_id)
        matched = True
    if not matched:
        raise ValueError("engine profile is not assigned to a supported output")
    return prewarm_runtime(requested_profile_id)


def unload_runtime_engine(kind, profile_id):
    normalized_kind = str(kind or "")
    requested_profile_id = str(profile_id or "")
    if not requested_profile_id:
        raise ValueError("engine profile id is required")
    with _STATE_LOCK:
        cancel_auto_analysis("分析引擎已卸载")
        cancel_play_prefetch()
        active_game = STATE.get("game")
        purge_bg_analysis_tasks(
            active_game.get("gameId") if isinstance(active_game, dict) else None
        )
    if normalized_kind == "decision":
        if (
            str(ACTION_RECOMMENDATIONS.runtime_status().get("profileId") or "")
            != requested_profile_id
        ):
            raise ValueError("engine profile is not assigned to action recommendation")
        ACTION_RECOMMENDATIONS.unload()
    elif normalized_kind == "opponent-analysis":
        if requested_profile_id not in set(
            OPPONENT_PREDICTIONS.runtime_status().get("profileIds") or []
        ):
            raise ValueError("engine profile is not assigned to opponent analysis")
        OPPONENT_PREDICTIONS.unload(requested_profile_id)
    else:
        raise ValueError("unknown engine kind")
    return build_state_payload(consume_thinking_time=False)


def describe_engine(payload):
    from engine_process_client import EngineProcessClient

    engine_id = str(payload.get("engineId") or "")
    command = payload.get("engineCommand")
    command = [str(part) for part in command] if isinstance(command, list) else None
    if not command:
        raise ValueError("engine executable is unavailable")
    client = EngineProcessClient(
        "selected",
        command=command,
        cwd=str(payload.get("engineCwd") or "") or None,
        expected_engine_id=engine_id or "",
        expected_engine_version=str(payload.get("engineVersion") or ""),
    )
    try:
        hello = client.describe()
    finally:
        client.shutdown()
    return hello


def emit(payload):
    with _EMIT_LOCK:
        sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
        sys.stdout.flush()


def get_decision_response_ms():
    response_times = [0.0, 0.0, 0.0, 0.0]
    analysis_ms = ACTION_RECOMMENDATIONS.average_response_ms()
    if analysis_ms > 0:
        response_times[STATE["controlledSeat"] % 4] = analysis_ms
    return response_times


def get_decision_activity():
    return ACTION_RECOMMENDATIONS.get_activity()


def get_decision_activity_errors():
    return ACTION_RECOMMENDATIONS.get_activity_errors()


def _emit_decision_activity(seat, state, error=None):
    del state, error
    decision_average_ms = get_decision_response_ms()
    activity = get_decision_activity()
    errors = get_decision_activity_errors()
    normalized_seat = int(seat) % 4
    effective_state = activity[normalized_seat]
    emit({
        "type": "model_activity",
        "model": "decision",
        "seat": normalized_seat,
        "activityState": effective_state,
        "active": effective_state == "running",
        "error": errors[normalized_seat],
        "averageMs": decision_average_ms[normalized_seat],
        "runtime": ACTION_RECOMMENDATIONS.runtime_status(),
        "timestamp": now_iso(),
    })


def _emit_opponent_analysis_activity(state, error=None):
    emit({
        "type": "model_activity",
        "model": "opponent_analysis",
        "activityState": str(state),
        "active": state == "running",
        "error": error,
        "averageMs": OPPONENT_PREDICTIONS.average_response_ms(),
        "runtime": OPPONENT_PREDICTIONS.runtime_status(),
        "timestamp": now_iso(),
    })


ACTION_RECOMMENDATIONS.set_activity_callback(_emit_decision_activity)
OPPONENT_PREDICTIONS.set_activity_callback(_emit_opponent_analysis_activity)


def create_match_state(seed):
    randomizer = random.Random(seed)
    return {
        "matchId": f"match_{STATE['nextGameId']:04d}",
        "seed": seed,
        "matchType": "hanchan",
        "players": 4,
        "roundIndex": 0,
        "bakaze": "E",
        "kyoku": 1,
        "honba": 0,
        "kyotaku": 0,
        "dealer": 0,
        "scores": [25000, 25000, 25000, 25000],
        "westEntryEnabled": True,
        "westEntered": False,
        "maxBakaze": "W",
        "maxKyoku": 4,
        "ended": False,
        "inRenchan": False,
        "roundSeeds": build_round_seed_stream(randomizer),
    }


def build_round_result_stub(snapshot, *, can_renchan=False, has_hora=False, has_abortive_ryukyoku=False, scores=None, kyotaku_left=None):
    sync_snapshot_state(snapshot)
    return {
        "roundIndex": snapshot["roundIndex"],
        "canRenchan": bool(can_renchan),
        "hasHora": bool(has_hora),
        "hasAbortiveRyukyoku": bool(has_abortive_ryukyoku),
        "kyotakuLeft": snapshot["kyotaku"] if kyotaku_left is None else int(kyotaku_left),
        "scores": copy.deepcopy(scores if scores is not None else snapshot["scores"]),
    }


def create_round_result_snapshot(snapshot, round_result, next_match_state):
    sync_snapshot_state(snapshot)
    result_snapshot = copy.deepcopy(snapshot)
    result_snapshot["phase"] = "round_result"
    result_snapshot["lastAction"] = {
        "type": "round_result",
        "actor": snapshot.get("dealer", 0),
        "result": {
            "canRenchan": bool(round_result["canRenchan"]),
            "hasHora": bool(round_result["hasHora"]),
            "hasAbortiveRyukyoku": bool(round_result["hasAbortiveRyukyoku"]),
            "eventType": round_result.get("eventType"),
            "eventData": copy.deepcopy(round_result.get("eventData") or {}),
            "deltas": copy.deepcopy((round_result.get("eventData") or {}).get("deltas", [0, 0, 0, 0])),
            "scores": copy.deepcopy(round_result["scores"]),
            "kyotakuLeft": int(round_result["kyotakuLeft"]),
        },
    }
    result_snapshot["pendingDiscard"] = None
    result_snapshot["reactionWindow"] = None
    result_snapshot["nextMatchState"] = copy.deepcopy(next_match_state)
    persist_snapshot_state(result_snapshot)
    return result_snapshot


def create_match_end_snapshot(snapshot, round_result, ended_match_state):
    end_snapshot = create_round_result_snapshot(snapshot, round_result, ended_match_state)
    end_snapshot["phase"] = "match_end"
    end_snapshot["lastAction"] = {
        "type": "match_result",
        "actor": ended_match_state.get("dealer", 0),
        "result": {
            "scores": copy.deepcopy(ended_match_state.get("scores", [25000, 25000, 25000, 25000])),
            "roundIndex": ended_match_state.get("roundIndex", 0),
            "bakaze": ended_match_state.get("bakaze", "E"),
            "kyoku": ended_match_state.get("kyoku", 1),
        },
    }
    return end_snapshot


def ensure_match_end_node(game, round_node_id, round_snapshot, round_result, ended_match_state):
    end_snapshot = create_match_end_snapshot(round_snapshot, round_result, ended_match_state)
    end_action = {
        "type": "match_end",
        "source": "system",
        "result": {
            "scores": copy.deepcopy(ended_match_state.get("scores", [25000, 25000, 25000, 25000])),
            "bakaze": ended_match_state.get("bakaze", "E"),
            "kyoku": ended_match_state.get("kyoku", 1),
        },
    }
    end_node_id = create_node(game, round_node_id, end_action, end_snapshot)
    attach_mainline(round_node_id, end_node_id)
    promote_path_to_mainline(game, end_node_id)
    return end_node_id


def create_next_kyoku_snapshot(snapshot, next_match_state):
    next_snapshot = create_initial_snapshot(next_match_state)
    next_snapshot["lastAction"] = {
        "type": "start_kyoku",
        "actor": next_match_state.get("dealer", 0),
        "bakaze": next_match_state.get("bakaze", "E"),
        "kyoku": next_match_state.get("kyoku", 1),
    }
    return next_snapshot


def has_wall_draw_available(snapshot):
    sync_snapshot_state(snapshot)
    return snapshot["drawIndex"] < len(snapshot["wall"])


def has_rinshan_draw_available(snapshot):
    sync_snapshot_state(snapshot)
    return len(snapshot.get("rinshanWall", [])) > 0


def reveal_next_dora(snapshot):
    next_index = len(snapshot.get("doraIndicators", []))
    dora_stack = snapshot.get("doraIndicatorStack", [])
    ura_stack = snapshot.get("uraIndicatorStack", [])
    if next_index >= len(dora_stack) or next_index >= len(ura_stack):
        return False
    snapshot["doraIndicators"].append(dora_stack[next_index])
    snapshot["uraIndicators"].append(ura_stack[next_index])
    snapshot["actionHistory"].append(
        {
            "type": "dora",
            "dora_marker": dora_stack[next_index],
        }
    )
    snapshot["lastAction"] = {
        "type": "dora",
        "pai": dora_stack[next_index],
    }
    persist_snapshot_state(snapshot)
    return True


def get_pending_dora_counts(snapshot):
    immediate = int(snapshot.get("pendingDoraRevealCount", 1 if snapshot.get("pendingDoraReveal") else 0))
    delayed = int(snapshot.get("pendingDoraRevealAfterActionCount", 0))
    return immediate, delayed


def set_pending_dora_counts(snapshot, immediate, delayed):
    immediate = max(0, int(immediate))
    delayed = max(0, int(delayed))
    if immediate:
        snapshot["pendingDoraRevealCount"] = immediate
        snapshot["pendingDoraReveal"] = True
    else:
        snapshot.pop("pendingDoraRevealCount", None)
        snapshot.pop("pendingDoraReveal", None)
    if delayed:
        snapshot["pendingDoraRevealAfterActionCount"] = delayed
    else:
        snapshot.pop("pendingDoraRevealAfterActionCount", None)


def queue_dora_reveal(snapshot, *, after_action=False):
    immediate, delayed = get_pending_dora_counts(snapshot)
    if after_action:
        delayed += 1
    else:
        immediate += 1
    set_pending_dora_counts(snapshot, immediate, delayed)


def promote_delayed_dora_reveal(snapshot):
    immediate, delayed = get_pending_dora_counts(snapshot)
    if delayed <= 0:
        return False
    delayed -= 1
    immediate += 1
    set_pending_dora_counts(snapshot, immediate, delayed)
    return True


def has_immediate_dora_reveal(snapshot):
    immediate, _delayed = get_pending_dora_counts(snapshot)
    return immediate > 0


def consume_immediate_dora_reveal(snapshot):
    immediate, delayed = get_pending_dora_counts(snapshot)
    if immediate <= 0:
        return False
    immediate -= 1
    set_pending_dora_counts(snapshot, immediate, delayed)
    return True


def reveal_all_pending_dora(snapshot):
    immediate, delayed = get_pending_dora_counts(snapshot)
    set_pending_dora_counts(snapshot, 0, 0)
    total = immediate + delayed
    revealed = False
    for _ in range(total):
        revealed = reveal_next_dora(snapshot) or revealed
    return revealed


def can_declare_kyuushu_kyuuhai(snapshot, actor, player_state=None):
    sync_snapshot_state(snapshot)
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


def detect_suufon_renda(snapshot):
    sync_snapshot_state(snapshot)
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
    return len(set(first_discards)) == 1 and first_discards[0] in {"E", "S", "W", "N"}


def detect_suukantsu(snapshot):
    sync_snapshot_state(snapshot)
    kan_melds = []
    for seat_melds in snapshot["melds"]:
        for meld in seat_melds:
            if meld.get("type") in ("daiminkan", "ankan", "kakan"):
                kan_melds.append(meld)
    if len(kan_melds) < 4:
        return False
    actors = {int(meld.get("actor", -1)) for meld in kan_melds}
    return len(actors) >= 2


def count_accepted_riichis(snapshot):
    sync_snapshot_state(snapshot)
    return sum(1 for value in snapshot.get("riichiAccepted", [False, False, False, False]) if value)


def ensure_ippatsu_flags(snapshot):
    flags = snapshot.get("ippatsuEligible")
    if not isinstance(flags, list) or len(flags) != 4:
        flags = [False, False, False, False]
        snapshot["ippatsuEligible"] = flags
    return flags


def clear_all_ippatsu(snapshot):
    flags = ensure_ippatsu_flags(snapshot)
    for seat in range(4):
        flags[seat] = False


def accept_riichi_for_seat(snapshot, seat, *, clear_pending=True):
    sync_snapshot_state(snapshot)
    seat = int(seat)
    already_accepted = bool(snapshot["riichiAccepted"][seat])
    if not already_accepted:
        snapshot["riichiAccepted"][seat] = True
        ensure_ippatsu_flags(snapshot)[seat] = True
        snapshot["scores"][seat] -= 1000
        snapshot["kyotaku"] += 1
        accepted_event = {
            "type": "reach_accepted",
            "actor": seat,
        }
        snapshot["lastAction"] = copy.deepcopy(accepted_event)
        snapshot["actionHistory"].append(copy.deepcopy(accepted_event))
    if clear_pending:
        snapshot["pendingRiichiSeat"] = None
    persist_snapshot_state(snapshot)
    return not already_accepted


def resolve_pending_riichi_acceptance(snapshot):
    sync_snapshot_state(snapshot)
    seat = snapshot.get("pendingRiichiSeat")
    if seat is None:
        return False
    return accept_riichi_for_seat(snapshot, seat, clear_pending=True)


def mark_abortive_ryukyoku(snapshot, reason):
    sync_snapshot_state(snapshot)
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
    persist_snapshot_state(snapshot)


def maybe_mark_abortive_ryukyoku(snapshot):
    if count_accepted_riichis(snapshot) >= 4:
        mark_abortive_ryukyoku(snapshot, "suucha_riichi")
        return True
    if detect_suufon_renda(snapshot):
        mark_abortive_ryukyoku(snapshot, "suufon_renda")
        return True
    if detect_suukantsu(snapshot):
        mark_abortive_ryukyoku(snapshot, "suukantsu")
        return True
    return False


def mark_exhaustive_ryukyoku(snapshot):
    sync_snapshot_state(snapshot)
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
    persist_snapshot_state(snapshot)


def build_terminal_round_result(snapshot):
    sync_snapshot_state(snapshot)
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
                "reasonLabel": last_action.get("reasonLabel") or get_abortive_reason_label(reason),
                "tenpaiSeats": tenpai_seats,
            },
        }

    return build_round_result_stub(
        snapshot,
        can_renchan=False,
        has_hora=False,
        has_abortive_ryukyoku=False,
        scores=copy.deepcopy(snapshot.get("scores", [25000, 25000, 25000, 25000])),
        kyotaku_left=int(snapshot.get("kyotaku", 0)),
    )


def commit_system_transition(game, parent_id, action, snapshot):
    child_id = create_node(game, parent_id, action, snapshot)
    attach_mainline(parent_id, child_id)
    game["currentNodeId"] = child_id
    promote_path_to_mainline(game, child_id)
    return child_id


def advance_terminal_round(game):
    current_node_id = game["currentNodeId"]
    current_snapshot = game["nodes"][current_node_id]["snapshot"]
    round_result = build_terminal_round_result(current_snapshot)
    next_match_state = apply_round_result_to_match_state(game["matchState"], round_result)
    round_snapshot = create_round_result_snapshot(current_snapshot, round_result, next_match_state)
    round_node_id = commit_system_transition(
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
        ensure_match_end_node(
            game,
            round_node_id,
            round_snapshot,
            round_result,
            next_match_state,
        )


def sync_snapshot_state(snapshot):
    match_state = snapshot.get("matchState")
    kyoku_state = snapshot.get("kyokuState")

    if not isinstance(match_state, dict):
        match_state = {
            "roundIndex": int(snapshot.get("roundIndex", 0)),
            "bakaze": snapshot.get("bakaze", "E"),
            "kyoku": int(snapshot.get("kyoku", 1)),
            "honba": int(snapshot.get("honba", 0)),
            "kyotaku": int(snapshot.get("kyotaku", 0)),
            "dealer": int(snapshot.get("dealer", 0)),
            "dealerOffset": int(snapshot.get("dealerOffset", 0)),
            "scores": copy.deepcopy(snapshot.get("scores", [25000, 25000, 25000, 25000])),
            "westEntered": bool(snapshot.get("westEntered", False)),
            "ended": snapshot.get("phase") == "match_end",
            "inRenchan": bool(snapshot.get("inRenchan", False)),
        }

    if not isinstance(kyoku_state, dict):
        kyoku_state = {
            "initialHands": copy.deepcopy(snapshot.get("initialHands", [[], [], [], []])),
            "startScores": copy.deepcopy(snapshot.get("startScores", snapshot.get("scores", [25000, 25000, 25000, 25000]))),
            "startKyotaku": int(snapshot.get("startKyotaku", snapshot.get("kyotaku", 0))),
            "fullWall": copy.deepcopy(snapshot.get("fullWall", [])),
            "hands": copy.deepcopy(snapshot.get("hands", [[], [], [], []])),
            "rivers": copy.deepcopy(snapshot.get("rivers", [[], [], [], []])),
            "wall": copy.deepcopy(snapshot.get("wall", [])),
            "rinshanWall": copy.deepcopy(snapshot.get("rinshanWall", [])),
            "drawIndex": int(snapshot.get("drawIndex", 0)),
            "doraIndicators": copy.deepcopy(snapshot.get("doraIndicators", [])),
            "uraIndicators": copy.deepcopy(snapshot.get("uraIndicators", [])),
            "doraIndicatorStack": copy.deepcopy(snapshot.get("doraIndicatorStack", [])),
            "uraIndicatorStack": copy.deepcopy(snapshot.get("uraIndicatorStack", [])),
            "melds": copy.deepcopy(snapshot.get("melds", [[], [], [], []])),
            "riichiDeclared": copy.deepcopy(snapshot.get("riichiDeclared", [False, False, False, False])),
            "riichiAccepted": copy.deepcopy(snapshot.get("riichiAccepted", [False, False, False, False])),
            "ippatsuEligible": copy.deepcopy(snapshot.get("ippatsuEligible", [False, False, False, False])),
            "pendingRiichiSeat": snapshot.get("pendingRiichiSeat"),
            "pendingRiichiDiscard": copy.deepcopy(snapshot.get("pendingRiichiDiscard")),
            "pendingKan": copy.deepcopy(snapshot.get("pendingKan")),
            "pendingRinshanDraw": bool(snapshot.get("pendingRinshanDraw", False)),
            "pendingDoraRevealCount": int(snapshot.get("pendingDoraRevealCount", 1 if snapshot.get("pendingDoraReveal") else 0)),
            "pendingDoraRevealAfterActionCount": int(snapshot.get("pendingDoraRevealAfterActionCount", 0)),
        }

    snapshot["matchState"] = match_state
    snapshot["kyokuState"] = kyoku_state

    snapshot["roundIndex"] = int(match_state.get("roundIndex", 0))
    snapshot["bakaze"] = match_state.get("bakaze", "E")
    snapshot["kyoku"] = int(match_state.get("kyoku", 1))
    snapshot["honba"] = int(match_state.get("honba", 0))
    snapshot["kyotaku"] = int(match_state.get("kyotaku", 0))
    snapshot["dealer"] = int(match_state.get("dealer", 0))
    snapshot["dealerOffset"] = int(match_state.get("dealerOffset", 0))
    snapshot["scores"] = copy.deepcopy(match_state.get("scores", [25000, 25000, 25000, 25000]))
    snapshot["westEntered"] = bool(match_state.get("westEntered", False))
    snapshot["inRenchan"] = bool(match_state.get("inRenchan", False))
    if "seed" not in snapshot:
        snapshot["seed"] = match_state.get("seed", 0)
    if "roundSeeds" not in snapshot:
        snapshot["roundSeeds"] = copy.deepcopy(match_state.get("roundSeeds", []))

    snapshot["initialHands"] = copy.deepcopy(kyoku_state.get("initialHands", [[], [], [], []]))
    snapshot["startScores"] = copy.deepcopy(kyoku_state.get("startScores", snapshot.get("scores", [25000, 25000, 25000, 25000])))
    snapshot["startKyotaku"] = int(kyoku_state.get("startKyotaku", snapshot.get("kyotaku", 0)))
    snapshot["fullWall"] = copy.deepcopy(kyoku_state.get("fullWall", []))
    snapshot["hands"] = copy.deepcopy(kyoku_state.get("hands", [[], [], [], []]))
    snapshot["rivers"] = copy.deepcopy(kyoku_state.get("rivers", [[], [], [], []]))
    snapshot["wall"] = copy.deepcopy(kyoku_state.get("wall", []))
    snapshot["rinshanWall"] = copy.deepcopy(kyoku_state.get("rinshanWall", []))
    snapshot["drawIndex"] = int(kyoku_state.get("drawIndex", 0))
    snapshot["doraIndicators"] = copy.deepcopy(kyoku_state.get("doraIndicators", []))
    snapshot["uraIndicators"] = copy.deepcopy(kyoku_state.get("uraIndicators", []))
    snapshot["doraIndicatorStack"] = copy.deepcopy(kyoku_state.get("doraIndicatorStack", []))
    snapshot["uraIndicatorStack"] = copy.deepcopy(kyoku_state.get("uraIndicatorStack", []))
    snapshot["melds"] = copy.deepcopy(kyoku_state.get("melds", [[], [], [], []]))
    snapshot["riichiDeclared"] = copy.deepcopy(kyoku_state.get("riichiDeclared", [False, False, False, False]))
    snapshot["riichiAccepted"] = copy.deepcopy(kyoku_state.get("riichiAccepted", [False, False, False, False]))
    snapshot["ippatsuEligible"] = copy.deepcopy(kyoku_state.get("ippatsuEligible", [False, False, False, False]))
    snapshot["pendingRiichiSeat"] = kyoku_state.get("pendingRiichiSeat")
    snapshot["pendingRiichiDiscard"] = copy.deepcopy(kyoku_state.get("pendingRiichiDiscard"))
    snapshot["pendingKan"] = copy.deepcopy(kyoku_state.get("pendingKan"))
    snapshot["pendingRinshanDraw"] = bool(kyoku_state.get("pendingRinshanDraw", False))
    set_pending_dora_counts(
        snapshot,
        int(kyoku_state.get("pendingDoraRevealCount", 1 if kyoku_state.get("pendingDoraReveal") else 0)),
        int(kyoku_state.get("pendingDoraRevealAfterActionCount", 0)),
    )
    return snapshot


def persist_snapshot_state(snapshot):
    if "matchState" not in snapshot or "kyokuState" not in snapshot:
        sync_snapshot_state(snapshot)
    match_state = snapshot["matchState"]
    kyoku_state = snapshot["kyokuState"]

    match_state["roundIndex"] = int(snapshot.get("roundIndex", 0))
    match_state["bakaze"] = snapshot.get("bakaze", "E")
    match_state["kyoku"] = int(snapshot.get("kyoku", 1))
    match_state["honba"] = int(snapshot.get("honba", 0))
    match_state["kyotaku"] = int(snapshot.get("kyotaku", 0))
    match_state["dealer"] = int(snapshot.get("dealer", 0))
    if "dealerOffset" in snapshot:
        match_state["dealerOffset"] = int(snapshot["dealerOffset"])
    match_state["scores"] = copy.deepcopy(snapshot.get("scores", [25000, 25000, 25000, 25000]))
    match_state["westEntered"] = bool(snapshot.get("westEntered", False))
    match_state["inRenchan"] = bool(snapshot.get("inRenchan", False))
    match_state["ended"] = snapshot.get("phase") == "match_end"

    kyoku_state["initialHands"] = copy.deepcopy(snapshot.get("initialHands", [[], [], [], []]))
    kyoku_state["startScores"] = copy.deepcopy(snapshot.get("startScores", snapshot.get("scores", [25000, 25000, 25000, 25000])))
    kyoku_state["startKyotaku"] = int(snapshot.get("startKyotaku", snapshot.get("kyotaku", 0)))
    kyoku_state["fullWall"] = copy.deepcopy(snapshot.get("fullWall", []))
    kyoku_state["hands"] = copy.deepcopy(snapshot.get("hands", [[], [], [], []]))
    kyoku_state["rivers"] = copy.deepcopy(snapshot.get("rivers", [[], [], [], []]))
    kyoku_state["wall"] = copy.deepcopy(snapshot.get("wall", []))
    kyoku_state["rinshanWall"] = copy.deepcopy(snapshot.get("rinshanWall", []))
    kyoku_state["drawIndex"] = int(snapshot.get("drawIndex", 0))
    kyoku_state["doraIndicators"] = copy.deepcopy(snapshot.get("doraIndicators", []))
    kyoku_state["uraIndicators"] = copy.deepcopy(snapshot.get("uraIndicators", []))
    kyoku_state["doraIndicatorStack"] = copy.deepcopy(snapshot.get("doraIndicatorStack", []))
    kyoku_state["uraIndicatorStack"] = copy.deepcopy(snapshot.get("uraIndicatorStack", []))
    kyoku_state["melds"] = copy.deepcopy(snapshot.get("melds", [[], [], [], []]))
    kyoku_state["riichiDeclared"] = copy.deepcopy(snapshot.get("riichiDeclared", [False, False, False, False]))
    kyoku_state["riichiAccepted"] = copy.deepcopy(snapshot.get("riichiAccepted", [False, False, False, False]))
    kyoku_state["ippatsuEligible"] = copy.deepcopy(snapshot.get("ippatsuEligible", [False, False, False, False]))
    kyoku_state["pendingRiichiSeat"] = snapshot.get("pendingRiichiSeat")
    kyoku_state["pendingRiichiDiscard"] = copy.deepcopy(snapshot.get("pendingRiichiDiscard"))
    kyoku_state["pendingKan"] = copy.deepcopy(snapshot.get("pendingKan"))
    kyoku_state["pendingRinshanDraw"] = bool(snapshot.get("pendingRinshanDraw", False))
    immediate, delayed = get_pending_dora_counts(snapshot)
    kyoku_state["pendingDoraRevealCount"] = immediate
    kyoku_state["pendingDoraRevealAfterActionCount"] = delayed
    return snapshot


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
    if full_wall is None:
        seed = get_round_seed(match_state, int(match_state.get("roundIndex", 0)))
        honba = int(match_state.get("honba", 0))
        if honba > 0:
            seed = seed + honba * 7919
        randomizer = random.Random(seed)
        full_wall = build_wall(randomizer)
    else:
        full_wall = [str(tile) for tile in full_wall]
    full_wall = tuple(full_wall)
    live_wall = full_wall[:122]
    rinshan_wall = tuple(full_wall[index] for index in RINSHAN_DRAW_POSITIONS)
    dora_indicator_stack = tuple(full_wall[index] for index in DORA_INDICATOR_POSITIONS)
    ura_indicator_stack = tuple(full_wall[index] for index in URA_INDICATOR_POSITIONS)
    initial_hands = [sort_tiles(live_wall[i * 13:(i + 1) * 13]) for i in range(4)]
    draw_index = 52
    dora_indicators = [dora_indicator_stack[0]]
    ura_indicators = [ura_indicator_stack[0]]
    dealer = int(match_state["dealer"])

    hands = copy.deepcopy(initial_hands)
    dealer_draw_tile = live_wall[draw_index]
    hands[dealer].append(dealer_draw_tile)
    hands[dealer] = sort_tiles(hands[dealer])
    draw_index += 1

    snapshot = {
        "matchState": copy.deepcopy(match_state),
        "initialHands": copy.deepcopy(initial_hands),
        "startScores": copy.deepcopy(match_state["scores"]),
        "startKyotaku": int(match_state["kyotaku"]),
        "fullWall": full_wall,
        "hands": copy.deepcopy(hands),
        "rivers": [[], [], [], []],
        "wall": live_wall,
        "rinshanWall": rinshan_wall,
        "drawIndex": draw_index,
        "dealer": dealer,
        "currentActor": dealer,
        "phase": "discard",
        "turn": 0,
        "doraIndicators": dora_indicators[:],
        "uraIndicators": ura_indicators[:],
        "doraIndicatorStack": dora_indicator_stack,
        "uraIndicatorStack": ura_indicator_stack,
        "bakaze": match_state["bakaze"],
        "kyoku": match_state["kyoku"],
        "honba": match_state["honba"],
        "kyotaku": match_state["kyotaku"],
        "scores": copy.deepcopy(match_state["scores"]),
        "roundIndex": match_state["roundIndex"],
        "westEntered": bool(match_state.get("westEntered", False)),
        "inRenchan": bool(match_state.get("inRenchan", False)),
        "lastAction": {
            "type": "tsumo",
            "actor": dealer,
            "pai": dealer_draw_tile,
        },
        "melds": [[], [], [], []],
        "riichiDeclared": [False, False, False, False],
        "riichiAccepted": [False, False, False, False],
        "ippatsuEligible": [False, False, False, False],
        "pendingRiichiSeat": None,
        "riichiDiscardState": None,
        "pendingRiichiDiscard": None,
        "pendingKan": None,
        "pendingRinshanDraw": False,
        "pendingDiscard": None,
        "reactionWindow": None,
        "actionHistory": [
            {
                "type": "tsumo",
                "actor": dealer,
                "pai": dealer_draw_tile,
                "tsumogiri": False,
            }
        ],
    }
    sync_snapshot_state(snapshot)
    return snapshot


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
    if not isinstance(tiles, list) or len(tiles) != 136:
        raise ValueError("牌山必须正好有 136 张牌。")
    normalized = [str(tile) for tile in tiles]
    allowed = set(SUIT_TILES + HONOR_TILES + ["5m", "5p", "5s", "5mr", "5pr", "5sr"])
    invalid = [tile for tile in normalized if tile not in allowed]
    if invalid:
        raise ValueError(f"牌山中存在非法牌张：{invalid[0]}")
    counts = {}
    for tile in normalized:
        counts[tile] = counts.get(tile, 0) + 1
    for tile in SUIT_TILES + HONOR_TILES:
        if counts.get(tile, 0) != 4:
            raise ValueError(f"{tile} 的数量必须是 4。")
    for tile in ("5mr", "5pr", "5sr"):
        if counts.get(tile, 0) != 1:
            raise ValueError(f"{tile} 的数量必须是 1。")
    for tile in ("5m", "5p", "5s"):
        if counts.get(tile, 0) != 3:
            raise ValueError(f"{tile} 的数量必须是 3。")
    return normalized


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

    purge_bg_analysis_tasks(game["gameId"], subtree_ids)

    for node_id in subtree_ids:
        game["nodes"].pop(node_id, None)

    game["nodes"][new_round_root_id] = new_round_root_node
    game_tree.mark_tree_changed(game)
    _invalidate_auto_analysis_timeline()
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


def _get_bg_analysis_task_key(game, node_id, analysis_key):
    return (game.get("gameId") if game else None, node_id, analysis_key)


def purge_bg_analysis_tasks(game_id, node_ids=None):
    if node_ids is None:
        stale_keys = [key for key in _BG_TASKS.keys() if key and key[0] == game_id]
        completed_keys = [key for key in _BG_COMPLETED if key and key[0] == game_id]
    else:
        node_id_set = set(node_ids)
        stale_keys = [
            key for key in _BG_TASKS.keys()
            if key and key[0] == game_id and key[1] in node_id_set
        ]
        completed_keys = [
            key for key in _BG_COMPLETED
            if key and key[0] == game_id and key[1] in node_id_set
        ]
    for key in stale_keys:
        future = _BG_TASKS.pop(key, None)
        if future is not None:
            try:
                future.cancel()
            except Exception:
                pass
    for key in completed_keys:
        try:
            _BG_COMPLETED.discard(key)
        except Exception:
            pass


def reset_runtime_for_game_change():
    global _DECISION_CACHE_EPOCH, _OPPONENT_ANALYSIS_CACHE_EPOCH

    cancel_play_prefetch()
    cancel_auto_analysis("牌谱已切换", emit_progress=False, cancel_opponent_analysis=False)
    _invalidate_auto_analysis_timeline()
    with AUTO_ANALYSIS_RUNTIME.lock:
        AUTO_ANALYSIS_RUNTIME.status.update({
            "status": "idle",
            "completed": 0,
            "total": 0,
            "cached": 0,
            "analyzed": 0,
            "failed": 0,
            "currentNodeId": None,
            "currentModel": None,
            "message": "",
        })
    _DECISION_CACHE_EPOCH += 1
    _OPPONENT_ANALYSIS_CACHE_EPOCH += 1
    for future in list(_BG_TASKS.values()):
        try:
            future.cancel()
        except Exception:
            pass
    _BG_TASKS.clear()
    _BG_COMPLETED.clear()
    _MJAI_STREAM_CACHE.clear()
    _LEGAL_ACTIONS_CACHE.clear()
    OPPONENT_PREDICTIONS.cancel_all()
    ACTION_RECOMMENDATIONS.reset_session()


def reserve_loaded_game_id(game_id):
    match = re.fullmatch(r"game_(\d+)", str(game_id or ""))
    if match:
        STATE["nextGameId"] = max(STATE["nextGameId"], int(match.group(1)) + 1)


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
    prefetch_game = getattr(_PLAY_PREFETCH_LOCAL, "game", None)
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
        _invalidate_auto_analysis_timeline()


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
        _invalidate_auto_analysis_timeline()
    return node_id


def _may_promote_mainline(game, force=False):
    return (
        force
        or STATE.get("mode") != "play"
        or getattr(_PLAY_PREFETCH_LOCAL, "game", None) is game
    )


def attach_mainline(parent_id, child_id, *, force=False):
    game = getattr(_PLAY_PREFETCH_LOCAL, "game", None) or STATE["game"]
    if game_tree.attach_main_child(
        game,
        parent_id,
        child_id,
        replace_existing=_may_promote_mainline(game, force),
    ):
        _invalidate_auto_analysis_timeline()


def promote_path_to_mainline(game, node_id, *, force=False):
    if not _may_promote_mainline(game, force):
        return
    if game_tree.promote_path_to_mainline(game, node_id):
        _invalidate_auto_analysis_timeline()


def replace_pending_review_main_child(game, parent_id, proposed_id, chosen_id):
    changed = game_tree.replace_pending_review_main_child(
        game,
        parent_id,
        proposed_id,
        chosen_id,
    )
    if changed:
        _invalidate_auto_analysis_timeline()
    return changed


def build_legal_actions(snapshot, controlled_seat=None):
    if controlled_seat is None:
        controlled_seat = STATE["controlledSeat"]
    controlled_seat = normalize_seat(controlled_seat)

    if snapshot["phase"] == "discard":
        actor = snapshot["currentActor"]
        if actor != controlled_seat:
            debug_flow(f"[FLOW] build_legal_actions SKIP phase=discard actor={actor} controlled={controlled_seat}")
            return []

        is_riichi = snapshot.get("riichiAccepted", [False, False, False, False])[actor]

        if is_riichi and snapshot.get("riichiDiscardState") == "ankan_choice":
            kan_actions = get_legal_kan_actions(snapshot, actor)
            valid_candidates = set(get_ankan_candidates(snapshot, actor))
            actions = [
                {
                    "id": f"kan:{entry['variant']}",
                    "type": entry["type"],
                    "variant": entry["variant"],
                    "actor": actor,
                    "label": entry["label"],
                    "pai": entry.get("pai"),
                    "consumed": copy.deepcopy(entry.get("consumed") or []),
                }
                for entry in kan_actions
                if entry["type"] == "ankan"
                and normalize_tile_family(entry.get("pai", "")) in valid_candidates
            ]
            if actions:
                action_history = snapshot.get("actionHistory") or []
                last_action = action_history[-1] if action_history else {}
                drawn_tile = (
                    str(last_action.get("pai") or "")
                    if last_action.get("type") == "tsumo"
                    and int(last_action.get("actor", -1)) == actor
                    else ""
                )
                actions.append({
                    "id": "riichi_ankan:skip",
                    "type": "none",
                    "variant": "skip_ankan",
                    "actor": actor,
                    "pai": drawn_tile,
                    "tsumogiri": True,
                    "label": "Skip (Tsumogiri)",
                })
            return actions

        if is_riichi:
            if snapshot.get("riichiDiscardState") == "pending_pause":
                return []
            if actor_just_drew(snapshot, actor) and can_declare_tsumo(snapshot, actor):
                hand = snapshot.get("hands", [[], [], [], []])[actor]
                action_history = snapshot.get("actionHistory") or []
                drawn_tile = ""
                if action_history:
                    last_action = action_history[-1]
                    if last_action.get("type") == "tsumo" and int(last_action.get("actor", -1)) == actor:
                        drawn_tile = str(last_action.get("pai") or "")
                if not drawn_tile and hand:
                    drawn_tile = hand[-1]
                actions = [
                    {
                        "id": "hora:tsumo",
                        "type": "hora",
                        "variant": "tsumo",
                        "actor": actor,
                        "label": "Tsumo",
                    }
                ]
                if drawn_tile and drawn_tile in hand:
                    actions.append({
                        "id": f"dahai:{drawn_tile}",
                        "type": "dahai",
                        "actor": actor,
                        "pai": drawn_tile,
                        "label": f"Tsumogiri {drawn_tile}",
                        "tsumogiri": True,
                    })
                return actions
            return []

        can_use_drawn_tile_options = actor_just_drew(snapshot, actor)

        hand = list(snapshot.get("hands", [[], [], [], []])[actor])
        drawn_tile = ""
        if can_use_drawn_tile_options:
            action_history = snapshot.get("actionHistory") or []
            if action_history:
                last_action = action_history[-1]
                if last_action.get("type") == "tsumo" and int(last_action.get("actor", -1)) == actor:
                    drawn_tile = str(last_action.get("pai") or "")
            if not drawn_tile and hand:
                drawn_tile = hand[-1]

        unique_tiles = unique_preserving_order(hand)
        forbidden_families = get_forbidden_discard_families_after_self_furo(snapshot, actor)
        actions = []
        for tile in unique_tiles:
            if normalize_tile_family(tile) in forbidden_families:
                continue
            count_in_hand = hand.count(tile)
            is_drawn_tile = (
                can_use_drawn_tile_options
                and drawn_tile
                and str(tile) == str(drawn_tile)
            )
            # When the drawn tile face has duplicates, split into tsumogiri vs hand-discard
            if is_drawn_tile and count_in_hand > 1:
                actions.append({
                    "id": f"dahai:{tile}:tsumo",
                    "type": "dahai",
                    "actor": actor,
                    "pai": tile,
                    "label": f"Tsumogiri {tile}",
                    "tsumogiri": True,
                })
                # Hand-discard of the old copy (not the drawn one)
                actions.append({
                    "id": f"dahai:{tile}",
                    "type": "dahai",
                    "actor": actor,
                    "pai": tile,
                    "label": f"Discard {tile}",
                })
            else:
                action = {
                    "id": f"dahai:{tile}",
                    "type": "dahai",
                    "actor": actor,
                    "pai": tile,
                    "label": f"Discard {tile}",
                }
                if is_drawn_tile:
                    action["label"] = f"Tsumogiri {tile}"
                    action["tsumogiri"] = True
                actions.append(action)
        player_state = build_player_state(snapshot, actor) if can_use_drawn_tile_options else None
        if can_use_drawn_tile_options and can_declare_tsumo(snapshot, actor, state=player_state):
            actions.append(
                {
                    "id": "hora:tsumo",
                    "type": "hora",
                    "variant": "tsumo",
                    "actor": actor,
                    "label": "Tsumo",
                }
            )
        if can_use_drawn_tile_options:
            for entry in get_legal_kan_actions(snapshot, actor):
                action = {
                    "id": f"kan:{entry['variant']}",
                    "type": entry["type"],
                    "variant": entry["variant"],
                    "actor": actor,
                    "label": entry["label"],
                    "pai": entry.get("pai"),
                    "consumed": copy.deepcopy(entry.get("consumed") or []),
                }
                actions.append(action)
        if can_use_drawn_tile_options and can_declare_riichi(snapshot, actor, state=player_state):
            actions.append(
                {
                    "id": "reach:declare",
                    "type": "reach",
                    "variant": "declare",
                    "actor": actor,
                    "label": "Cancel Riichi" if snapshot.get("pendingRiichiSeat") == actor else "Riichi",
                }
            )
        if can_declare_kyuushu_kyuuhai(snapshot, actor, player_state=player_state):
            actions.append(
                {
                    "id": "ryukyoku:kyuushu_kyuuhai",
                    "type": "ryukyoku",
                    "variant": "kyuushu_kyuuhai",
                    "actor": actor,
                    "label": "Abortive Draw",
                }
            )
        return actions

    if snapshot["phase"] in ("reaction_window", "kan_reaction_window"):
        reaction_window = snapshot.get("reactionWindow") if snapshot["phase"] == "reaction_window" else snapshot.get("kanReactionWindow")
        reaction_window = reaction_window or {}
        resolved_seats = {
            int(seat)
            for seat in reaction_window.get("resolvedSeats", [])
            if isinstance(seat, int) or str(seat).isdigit()
        }
        if controlled_seat in resolved_seats:
            return []
        controlled_reaction = next((item for item in reaction_window.get("reactions", []) if item.get("seat") == controlled_seat), None)
        if not controlled_reaction:
            return []
        return _build_local_reaction_actions(snapshot, controlled_seat)

    if snapshot["phase"] == "reach_declaration":
        actor = snapshot["currentActor"]
        if actor != controlled_seat:
            return []
        valid_families = set(get_valid_riichi_discards(snapshot, actor))
        hand = list(snapshot["hands"][actor])
        unique_tiles = unique_preserving_order(hand)
        action_history = snapshot.get("actionHistory") or []
        drawn_tile = ""
        if action_history:
            last_action = action_history[-1]
            if last_action.get("type") == "tsumo" and int(last_action.get("actor", -1)) == actor:
                drawn_tile = str(last_action.get("pai") or "")
        if not drawn_tile and hand:
            drawn_tile = str(hand[-1])
        actions = []
        for tile in unique_tiles:
            if normalize_tile_family(tile) not in valid_families:
                continue
            is_drawn_tile = bool(drawn_tile and tile == drawn_tile)
            if is_drawn_tile and hand.count(tile) > 1:
                actions.append({
                    "id": f"dahai:{tile}:tsumo",
                    "type": "dahai",
                    "actor": actor,
                    "pai": tile,
                    "label": f"Riichi Tsumogiri {tile}",
                    "riichi": True,
                    "tsumogiri": True,
                })
                actions.append({
                    "id": f"dahai:{tile}",
                    "type": "dahai",
                    "actor": actor,
                    "pai": tile,
                    "label": f"Riichi Discard {tile}",
                    "riichi": True,
                })
                continue
            action = {
                "id": f"dahai:{tile}",
                "type": "dahai",
                "actor": actor,
                "pai": tile,
                "label": f"Riichi Discard {tile}",
                "riichi": True,
            }
            if is_drawn_tile:
                action["tsumogiri"] = True
            actions.append(action)
        return actions

    return []


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
    sync_snapshot_state(snapshot)
    if not actor_just_drew(snapshot, actor):
        return []
    hand = list(snapshot.get("hands", [[], [], [], []])[actor])
    melds = list(snapshot.get("melds", [[], [], [], []])[actor])
    actions = []

    grouped_hand = {}
    for tile in hand:
        grouped_hand.setdefault(normalize_tile_family(tile), []).append(tile)

    for family, tiles in grouped_hand.items():
        if len(tiles) >= 4:
            actual_tiles = tiles[:4]
            actions.append(
                {
                    "type": "ankan",
                    "variant": f"ankan:{family}",
                    "pai": actual_tiles[0],
                    "consumed": copy.deepcopy(actual_tiles),
                    "label": f"Closed Kan {family}",
                }
            )

    for meld in melds:
        if meld.get("type") != "pon":
            continue
        family = normalize_tile_family(str(meld.get("pai") or ""))
        matching_tiles = grouped_hand.get(family) or []
        if not matching_tiles:
            continue
        pon_tiles = list(meld.get("consumed") or [])
        consumed = copy.deepcopy((pon_tiles + [matching_tiles[0]])[:3])
        actions.append(
            {
                "type": "kakan",
                "variant": f"kakan:{family}",
                "pai": matching_tiles[0],
                "consumed": consumed,
                "label": f"Add Kan {family}",
            }
        )

    return actions


def _unique_consumed_combinations(tiles, count):
    unique = {}
    for selected in combinations(tiles, count):
        canonical = tuple(sort_tiles(list(selected)))
        unique[canonical] = list(canonical)
    return list(unique.values())


def _build_local_chi_actions(snapshot, actor, called_tile):
    normalized = normalize_tile_family(str(called_tile or ""))
    if len(normalized) != 2 or normalized[0] not in "123456789" or normalized[1] not in ("m", "p", "s"):
        return []

    hand = list(snapshot.get("hands", [[], [], [], []])[actor])
    number = int(normalized[0])
    suit = normalized[1]
    actions = []
    variants = [
        ("chi_low", [number + 1, number + 2]),
        ("chi_mid", [number - 1, number + 1]),
        ("chi_high", [number - 2, number - 1]),
    ]
    for variant, needed_numbers in variants:
        if any(value < 1 or value > 9 for value in needed_numbers):
            continue
        exact_options = []
        for target_number in needed_numbers:
            family = f"{target_number}{suit}"
            matches = unique_preserving_order(
                tile for tile in hand
                if normalize_tile_family(tile) == family
            )
            if not matches:
                exact_options = []
                break
            exact_options.append(matches)
        if not exact_options:
            continue
        for selected in product(*exact_options):
            consumed = list(selected)
            consumed_id = ",".join(consumed)
            actions.append({
                "id": f"reaction:{variant}:{consumed_id}",
                "type": "chi",
                "variant": variant,
                "actor": actor,
                "label": variant,
                "pai": called_tile,
                "consumed": copy.deepcopy(consumed),
            })
    return actions


def _build_local_reaction_actions(snapshot, actor):
    if snapshot["phase"] == "kan_reaction_window":
        pending_kan = snapshot.get("pendingKan") or {}
        kan_actor = int(pending_kan.get("actor", snapshot.get("currentActor", 0)))
        kan_tile = str(pending_kan.get("pai") or "")
        legal_actions = []
        if can_resolve_hora_reaction(snapshot, actor, kan_actor, kan_tile):
            legal_actions.append(
                {
                    "id": "reaction:hora",
                    "type": "hora",
                    "variant": "hora",
                    "actor": actor,
                    "label": "Ron",
                    "pai": kan_tile,
                }
            )
        if legal_actions:
            legal_actions.append(
                {
                    "id": "reaction:none",
                    "type": "none",
                    "variant": "none",
                    "actor": actor,
                    "label": "Pass",
                }
            )
        return legal_actions

    reaction_window = snapshot.get("reactionWindow") or {}
    discard = reaction_window.get("discard") or {}
    discard_actor = int(discard.get("actor", -1))
    called_tile = str(discard.get("pai") or "")
    target_actor = int(discard.get("targetActor", -1))
    legal_actions = []

    if can_resolve_hora_reaction(snapshot, actor, discard_actor, called_tile):
        legal_actions.append(
            {
                "id": "reaction:hora",
                "type": "hora",
                "variant": "hora",
                "actor": actor,
                "label": "Ron",
                "pai": called_tile,
            }
        )

    if not snapshot.get("riichiAccepted", [False, False, False, False])[actor]:
        hand = list(snapshot.get("hands", [[], [], [], []])[actor])
        matching_tiles = [tile for tile in hand if normalize_tile_family(tile) == normalize_tile_family(called_tile)]
        for consumed in _unique_consumed_combinations(matching_tiles, 2):
            consumed_id = ",".join(consumed)
            legal_actions.append({
                    "id": f"reaction:pon:{consumed_id}",
                    "type": "pon",
                    "variant": "pon",
                    "actor": actor,
                    "label": "Pon",
                    "pai": called_tile,
                    "consumed": copy.deepcopy(consumed),
                })
        for consumed in _unique_consumed_combinations(matching_tiles, 3):
            consumed_id = ",".join(consumed)
            legal_actions.append({
                    "id": f"reaction:daiminkan:{consumed_id}",
                    "type": "daiminkan",
                    "variant": "daiminkan",
                    "actor": actor,
                    "label": "Kan",
                    "pai": called_tile,
                    "consumed": copy.deepcopy(consumed),
                })
        if actor == target_actor:
            legal_actions.extend(_build_local_chi_actions(snapshot, actor, called_tile))

    if legal_actions:
        legal_actions.append(
            {
                "id": "reaction:none",
                "type": "none",
                "variant": "none",
                "actor": actor,
                "label": "Pass",
            }
        )
    return legal_actions


def apply_pending_seat_switch_if_ready(snapshot):
    pending_seat = STATE.get("pendingSeatSwitch")
    if pending_seat is None:
        return False

    STATE["controlledSeat"] = pending_seat
    STATE["pendingSeatSwitch"] = None
    return True


def _submit_background_analysis(current_node, snapshot):
    if not STATE.get("decisionRecommendationsEnabled", True):
        return None
    if snapshot.get("phase") not in ("discard", "reach_declaration", "reaction_window", "kan_reaction_window"):
        return None

    analysis_key = get_analysis_cache_key(snapshot)
    if analysis_key in current_node.get("analysisCache", {}):
        return None

    game = STATE.get("game")
    node_id = current_node.get("id")
    game_id = game.get("gameId") if game else None
    if play_prefetch_owns_decision(node_id, analysis_key):
        return None
    if auto_analysis_owns_item("decision", node_id):
        return None
    task_key = _get_bg_analysis_task_key(game, node_id, analysis_key)
    if task_key in _BG_TASKS:
        return None
    if task_key in _BG_COMPLETED:
        return None

    seat = STATE["controlledSeat"]
    model_path = get_action_engine_weight_path()
    stream_bundle = get_cached_mjai_stream_bundle(game, node_id, seat)
    submitted_at = time.perf_counter()
    cache_epoch = _DECISION_CACHE_EPOCH
    legal_actions = build_legal_actions(snapshot, controlled_seat=seat)

    if snapshot["phase"] in ("discard", "reach_declaration"):
        def _task():
            started_at = time.perf_counter()
            analysis = analyze_discard_choices(
                ACTION_RECOMMENDATIONS,
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
    else:
        def _task():
            started_at = time.perf_counter()
            analysis = analyze_action_choices(
                ACTION_RECOMMENDATIONS,
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

    def _on_complete(future):
        should_mark_completed = False
        tree_updates = []
        try:
            wrapped = future.result()
            if (
                cache_epoch != _DECISION_CACHE_EPOCH
                or STATE.get("game") is not game
                or game.get("nodes", {}).get(node_id) is not current_node
            ):
                return
            result = wrapped.get("analysis") if isinstance(wrapped, dict) else wrapped
            if isinstance(result, dict) and not result.get("error"):
                stored = _store_decision_analysis(game, current_node, analysis_key, result)
                if stored is not None:
                    _set_auto_analysis_timeline_cached("decision", node_id, True)
                    tree_updates = update_cached_child_comparisons(game, current_node, result, seat)
                    should_mark_completed = True
            if STATE.get("decisionRecommendationsEnabled", True):
                emit({
                    "type": "analysis_ready",
                    "nodeId": node_id,
                    "gameId": game_id,
                    "analysisKey": analysis_key,
                    "analysis": result,
                    "treeComparisons": tree_updates,
                    "treeRevision": int(game.get("treeRevision", 0)) if game else None,
                    "state": build_state_payload(),
                    "timestamp": now_iso(),
                })
        except Exception:
            pass
        finally:
            if _BG_TASKS.get(task_key) is future:
                _BG_TASKS.pop(task_key, None)
            if should_mark_completed:
                _BG_COMPLETED.add(task_key)
                emit({
                    "type": "record_changed",
                    "gameId": game_id,
                    "change": "decision_analysis_cache",
                    "timestamp": now_iso(),
                })

    future = _BG_EXECUTOR.submit(_task)
    future.add_done_callback(_on_complete)
    _BG_TASKS[task_key] = future
    return None


def _get_or_schedule_analysis(current_node, snapshot, legal_actions):
    if not STATE.get("decisionRecommendationsEnabled", True):
        return None
    if not legal_actions:
        return None

    analysis_key = get_analysis_cache_key(snapshot)

    if analysis_key in current_node.get("analysisCache", {}):
        return copy.deepcopy(current_node["analysisCache"][analysis_key])

    if not ACTION_RECOMMENDATIONS.accepts_requests():
        return find_stale_cache_entry(
            STATE.get("game"),
            current_node,
            analysis_key,
            "analysisCache",
        )

    if snapshot.get("phase") not in ("discard", "reach_declaration", "reaction_window", "kan_reaction_window"):
        return None

    _submit_background_analysis(current_node, snapshot)
    return find_stale_cache_entry(
        STATE.get("game"),
        current_node,
        analysis_key,
        "analysisCache",
    )


def get_analysis_cache_key(snapshot):
    phase = snapshot.get("phase")
    if phase == "draw_or_discard":
        phase = "discard"
    return decision_cache_key(
        STATE["controlledSeat"],
        phase,
        _current_decision_analysis_source(),
    )


def _store_decision_analysis(game, node, cache_key, result, *, source=None):
    if not isinstance(game, dict) or not isinstance(node, dict) or not isinstance(result, dict):
        return None
    source = copy.deepcopy(source) if isinstance(source, dict) else _current_decision_analysis_source()
    source["displayName"] = _analysis_source_display_name("decision")
    expected_source_id = (cache_key_context(cache_key) or {}).get("sourceId")
    if expected_source_id != source["id"]:
        return None
    register_analysis_source(game, source, result)
    compact = copy.deepcopy(result)
    compact.pop("engineFingerprint", None)
    compact.pop("hostPostprocessorVersion", None)
    cache = node.setdefault("analysisCache", {})
    prune_stale_cache_entries(cache, cache_key)
    cache[cache_key] = compact
    return cache[cache_key]


def _build_cached_child_comparison(parent_node, child_node, analysis, controlled_seat):
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
        return build_comparison_result(
            analysis,
            tile,
            actor,
            action.get("tsumogiri"),
        ) if tile else None
    if parent_phase in ("draw_or_discard", "discard", "reach_declaration"):
        return build_special_action_comparison_result(analysis, action_type, actor, variant)
    if parent_phase in ("reaction_window", "kan_reaction_window"):
        return build_reaction_comparison_result(
            analysis,
            action_type,
            actor,
            variant,
            consumed=action.get("consumed"),
        )
    return None


def update_cached_child_comparisons(game, parent_node, analysis, controlled_seat, *, only_missing=False):
    updates = []
    for child_id in parent_node.get("children", []):
        child_node = game.get("nodes", {}).get(child_id)
        if not child_node or (only_missing and child_node.get("comparison")):
            continue
        try:
            comparison = _build_cached_child_comparison(parent_node, child_node, analysis, controlled_seat)
        except Exception:
            comparison = None
        if comparison is None or comparison == child_node.get("comparison"):
            continue
        child_node["comparison"] = copy.deepcopy(comparison)
        updates.append({"id": child_id, "comparison": copy.deepcopy(comparison)})
    return updates


def backfill_cached_child_comparisons(game):
    controlled_seat = STATE["controlledSeat"]
    updates = []
    for parent_node in game.get("nodes", {}).values():
        snapshot = parent_node.get("snapshot") or {}
        phase = str(snapshot.get("phase") or "")
        if phase == "draw_or_discard":
            phase = "discard"
        analysis_key = decision_cache_key(
            controlled_seat,
            phase,
            _current_decision_analysis_source(),
        )
        analysis = (parent_node.get("analysisCache") or {}).get(analysis_key)
        if not isinstance(analysis, dict) or analysis.get("error"):
            continue
        updates.extend(update_cached_child_comparisons(
            game,
            parent_node,
            analysis,
            controlled_seat,
            only_missing=True,
        ))
    return updates


def resolve_analysis_for_current_node(current_node, snapshot, legal_actions):
    if not STATE.get("decisionRecommendationsEnabled", True):
        return None
    if not legal_actions:
        return None

    analysis_key = get_analysis_cache_key(snapshot)

    stream_bundle = get_cached_mjai_stream_bundle(STATE["game"], current_node["id"], STATE["controlledSeat"])

    if snapshot["phase"] in ("draw_or_discard", "discard", "reach_declaration"):
        resolver = lambda: analyze_discard_choices(  # noqa: E731
            ACTION_RECOMMENDATIONS,
            snapshot,
            STATE["controlledSeat"],
            get_action_engine_weight_path(),
            mjai_events=stream_bundle["events"],
            mjai_prefix_hashes=stream_bundle["prefixHashes"],
            mjai_events_hash=stream_bundle["eventHash"],
            legal_actions=legal_actions,
            position_id=current_node.get("id", ""),
        )
        empty = {
            "error": None,
            "model": "decision-engine",
            "seat": STATE["controlledSeat"],
            "discardEntries": [],
        }
    elif snapshot["phase"] in ("reaction_window", "kan_reaction_window"):
        resolver = lambda: analyze_action_choices(  # noqa: E731
            ACTION_RECOMMENDATIONS,
            snapshot,
            STATE["controlledSeat"],
            get_action_engine_weight_path(),
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
            "seat": STATE["controlledSeat"],
            "reactionEntries": [],
            "bestAction": None,
        }
    else:
        return None

    try:
        if analysis_key not in current_node["analysisCache"]:
            resolved = resolver()
            cached_analysis = _store_decision_analysis(
                STATE["game"],
                current_node,
                analysis_key,
                resolved,
            )
            _set_auto_analysis_timeline_cached(
                "decision",
                current_node.get("id"),
                isinstance(cached_analysis, dict) and not cached_analysis.get("error"),
            )
        cached = current_node.get("analysisCache", {}).get(analysis_key)
        return copy.deepcopy(cached) if isinstance(cached, dict) else empty
    except Exception as error:  # pylint: disable=broad-except
        empty["error"] = str(error)
        return empty


def ensure_analysis_cached(current_node, snapshot):
    if not STATE.get("decisionRecommendationsEnabled", True):
        return None
    sync_snapshot_state(snapshot)
    if snapshot.get("phase") not in ("draw_or_discard", "discard", "reach_declaration", "reaction_window", "kan_reaction_window"):
        return None

    analysis_key = get_analysis_cache_key(snapshot)
    if analysis_key in current_node["analysisCache"]:
        return current_node["analysisCache"][analysis_key]

    if not ACTION_RECOMMENDATIONS.accepts_requests():
        return None

    task_key = _get_bg_analysis_task_key(STATE.get("game"), current_node.get("id"), analysis_key)
    bg_future = _BG_TASKS.get(task_key)
    if bg_future is not None:
        if bg_future.done():
            try:
                result = bg_future.result()
                del _BG_TASKS[task_key]
                if isinstance(result, dict) and not result.get("error"):
                    stored = _store_decision_analysis(
                        STATE["game"],
                        current_node,
                        analysis_key,
                        result,
                    )
                    if stored is not None:
                        _set_auto_analysis_timeline_cached("decision", current_node.get("id"), True)
                        return stored
            except Exception:
                del _BG_TASKS[task_key]
        return None

    if analysis_key in current_node["analysisCache"]:
        return current_node["analysisCache"][analysis_key]

    legal_actions = get_node_legal_actions(STATE["game"], current_node["id"])
    if not legal_actions:
        return None

    analysis = resolve_analysis_for_current_node(current_node, snapshot, legal_actions)
    if analysis is None or analysis.get("error"):
        return None
    stored = _store_decision_analysis(STATE["game"], current_node, analysis_key, analysis)
    if stored is not None:
        _set_auto_analysis_timeline_cached("decision", current_node.get("id"), True)
    return stored


def _invalidate_auto_analysis_timeline():
    if getattr(_PLAY_PREFETCH_LOCAL, "game", None) is not None:
        return
    AUTO_ANALYSIS_RUNTIME.invalidate_timeline()


def _ensure_auto_analysis_timeline_locked(game, seat, model_path):
    signature = (
        id(game),
        AUTO_ANALYSIS_RUNTIME.timeline_structure_revision,
        int(seat),
        str(model_path),
        _current_decision_analysis_source(model_path)["id"],
        _get_opponent_analysis_cache_key(seat),
    )
    if AUTO_ANALYSIS_RUNTIME.timeline_matches(signature):
        return

    round_root_map = auto_analysis_plan.build_round_root_map(game)
    start_node_id = auto_analysis_plan.timeline_start_node(game, round_root_map)
    items = _build_auto_analysis_plan(
        game,
        seat,
        model_path,
        start_node_id=start_node_id,
        round_root_map=round_root_map,
    )
    AUTO_ANALYSIS_RUNTIME.replace_timeline(signature, items)


def _set_auto_analysis_timeline_cached(kind, node_id, cached):
    AUTO_ANALYSIS_RUNTIME.set_timeline_cached(kind, node_id, cached)


def get_auto_analysis_status(*, include_timeline=True):
    if not include_timeline:
        status = AUTO_ANALYSIS_RUNTIME.status_snapshot()
        status["timeline"] = ""
        status["timelineReady"] = 0
        return status

    with _STATE_LOCK:
        game = STATE.get("game")
        game_loaded = STATE.get("gameLoaded") and isinstance(game, dict)
        seat = int(STATE.get("controlledSeat", 0))
        model_path = get_action_engine_weight_path() if game_loaded else ""
        with AUTO_ANALYSIS_RUNTIME.lock:
            status = AUTO_ANALYSIS_RUNTIME.status_snapshot()
            if not game_loaded:
                status["timeline"] = ""
                status["timelineReady"] = 0
                return status

            _ensure_auto_analysis_timeline_locked(game, seat, model_path)
            status["timeline"], status["timelineReady"] = AUTO_ANALYSIS_RUNTIME.timeline_progress(
                status.get("currentModel"),
                status.get("currentNodeId"),
            )
            return status


def _emit_auto_analysis_progress():
    game = STATE.get("game")
    emit({
        "type": "auto_analysis_progress",
        "gameId": game.get("gameId") if isinstance(game, dict) else None,
        "autoAnalysis": get_auto_analysis_status(),
        "timestamp": now_iso(),
    })


def _auto_decision_cache_key(seat, snapshot, model_path):
    phase = snapshot.get("phase")
    if phase == "draw_or_discard":
        phase = "discard"
    return decision_cache_key(
        seat,
        phase,
        _current_decision_analysis_source(model_path),
    )


def _build_auto_analysis_plan(
    game,
    seat,
    model_path,
    *,
    start_node_id=None,
    round_root_map=None,
):
    if round_root_map is None:
        round_root_map = auto_analysis_plan.build_round_root_map(game)
    round_order = auto_analysis_plan.order_rounds(
        game,
        game.get("currentNodeId") if start_node_id is None else start_node_id,
        round_root_map,
    )
    opponent_input_mode = _get_opponent_analysis_input_mode()
    opponent_cache_key = _get_opponent_analysis_cache_key(seat)
    decision_source = _current_decision_analysis_source(model_path)
    items = []
    for round_root_id in round_order:
        for node_id in auto_analysis_plan.order_round_nodes(game, round_root_id, round_root_map):
            node = game["nodes"][node_id]
            snapshot = node.get("snapshot") or {}
            sync_snapshot_state(snapshot)
            phase = snapshot.get("phase")
            if phase in ("draw_or_discard", "discard", "reach_declaration", "reaction_window", "kan_reaction_window"):
                legal_actions = get_node_legal_actions(game, node_id, controlled_seat=seat)
                if legal_actions:
                    decision_cache_key = _auto_decision_cache_key(seat, snapshot, model_path)
                    decision_result = (node.get("analysisCache") or {}).get(decision_cache_key)
                    items.append({
                        "kind": "decision",
                        "nodeId": node_id,
                        "roundRootId": round_root_id,
                        "cacheKey": decision_cache_key,
                        "source": copy.deepcopy(decision_source),
                        "cached": isinstance(decision_result, dict) and not decision_result.get("error"),
                    })

            opponent_result = (node.get(OPPONENT_ANALYSIS_CACHE_FIELD) or {}).get(opponent_cache_key)
            items.append({
                "kind": "opponent",
                "nodeId": node_id,
                "roundRootId": round_root_id,
                "cacheKey": opponent_cache_key,
                "inputMode": opponent_input_mode,
                "cached": isinstance(opponent_result, dict) and opponent_result.get("status") == "ready",
            })
    return items


def _auto_analysis_kind_enabled(kind):
    if kind == "decision":
        return not ACTION_RECOMMENDATIONS.runtime_status().get("unloaded", False)
    return not OPPONENT_PREDICTIONS.runtime_status().get("unloaded", False)


def auto_analysis_owns_item(kind, node_id):
    with AUTO_ANALYSIS_RUNTIME.lock:
        context = AUTO_ANALYSIS_RUNTIME.context
        if (
            not isinstance(context, dict)
            or AUTO_ANALYSIS_RUNTIME.status.get("status") != "running"
            or context.get("game") is not STATE.get("game")
        ):
            return False
        if (
            AUTO_ANALYSIS_RUNTIME.status.get("currentModel") == kind
            and AUTO_ANALYSIS_RUNTIME.status.get("currentNodeId") == node_id
        ):
            return True
        return any(
            item.get("kind") == kind and item.get("nodeId") == node_id
            for item in context["pending"]
        )


def cancel_auto_analysis(message="已停止", *, emit_progress=True, cancel_opponent_analysis=True):
    with AUTO_ANALYSIS_RUNTIME.lock:
        was_running = AUTO_ANALYSIS_RUNTIME.status.get("status") == "running"
        AUTO_ANALYSIS_RUNTIME.generation += 1
        future = AUTO_ANALYSIS_RUNTIME.future
        reprioritize_timer = AUTO_ANALYSIS_RUNTIME.reprioritize_timer
        AUTO_ANALYSIS_RUNTIME.future = None
        AUTO_ANALYSIS_RUNTIME.context = None
        AUTO_ANALYSIS_RUNTIME.reprioritize_timer = None
        AUTO_ANALYSIS_RUNTIME.reprioritize_serial += 1
        if was_running:
            AUTO_ANALYSIS_RUNTIME.status.update({
                "status": "canceled",
                "currentNodeId": None,
                "currentModel": None,
                "message": message,
            })
        status = copy.deepcopy(AUTO_ANALYSIS_RUNTIME.status)
    if future is not None:
        try:
            future.cancel()
        except Exception:
            pass
    if reprioritize_timer is not None:
        reprioritize_timer.cancel()
    if cancel_opponent_analysis:
        OPPONENT_PREDICTIONS.cancel_background()
    if was_running and emit_progress:
        _emit_auto_analysis_progress()
    return status


def _run_auto_decision_item(game, item, seat, model_path):
    node = game["nodes"][item["nodeId"]]
    snapshot = node["snapshot"]
    stream_bundle = get_cached_mjai_stream_bundle(game, item["nodeId"], seat)
    legal_actions = build_legal_actions(snapshot, controlled_seat=seat)
    if snapshot.get("phase") in ("draw_or_discard", "discard", "reach_declaration"):
        return analyze_discard_choices(
            ACTION_RECOMMENDATIONS,
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
        ACTION_RECOMMENDATIONS,
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


def _complete_auto_analysis_item(generation, item, result=None, error=None):
    success = False
    tree_updates = []
    with _STATE_LOCK:
        with AUTO_ANALYSIS_RUNTIME.lock:
            context = AUTO_ANALYSIS_RUNTIME.context
            if (
                not isinstance(context, dict)
                or context.get("generation") != generation
                or AUTO_ANALYSIS_RUNTIME.status.get("status") != "running"
            ):
                return
            game = context["game"]
            seat = context["seat"]
        if STATE.get("game") is not game:
            return
        node = game.get("nodes", {}).get(item.get("nodeId"))
        if isinstance(node, dict) and isinstance(result, dict) and not result.get("error"):
            if item.get("kind") == "decision":
                stored = _store_decision_analysis(
                    game,
                    node,
                    item["cacheKey"],
                    result,
                    source=item.get("source"),
                )
                if stored is not None:
                    _set_auto_analysis_timeline_cached("decision", item.get("nodeId"), True)
                    tree_updates = update_cached_child_comparisons(game, node, result, seat)
                    success = True
            else:
                success = _cache_opponent_analysis_result(result, require_current=False)

    with AUTO_ANALYSIS_RUNTIME.lock:
        context = AUTO_ANALYSIS_RUNTIME.context
        if not isinstance(context, dict) or context.get("generation") != generation:
            return
        AUTO_ANALYSIS_RUNTIME.future = None
        context["attempted"].add(auto_analysis_plan.item_key(item))
        AUTO_ANALYSIS_RUNTIME.status["completed"] += 1
        if success:
            AUTO_ANALYSIS_RUNTIME.status["analyzed"] += 1
        else:
            AUTO_ANALYSIS_RUNTIME.status["failed"] += 1
            if error:
                AUTO_ANALYSIS_RUNTIME.status["message"] = str(error)
        AUTO_ANALYSIS_RUNTIME.status["currentNodeId"] = None
        AUTO_ANALYSIS_RUNTIME.status["currentModel"] = None

    if success:
        if item.get("kind") == "decision":
            emit({
                "type": "record_changed",
                "gameId": context["gameId"],
                "change": "decision_analysis_cache",
                "timestamp": now_iso(),
            })
        if item.get("kind") == "decision" and context["game"].get("currentNodeId") == item.get("nodeId"):
            emit({
                "type": "analysis_ready",
                "nodeId": item["nodeId"],
                "gameId": context["gameId"],
                "analysisKey": item["cacheKey"],
                "analysis": result,
                "treeComparisons": tree_updates,
                "treeRevision": int(context["game"].get("treeRevision", 0)),
                "state": build_state_payload(),
                "timestamp": now_iso(),
            })
    if tree_updates:
        emit({
            "type": "auto_analysis_tree_updates",
            "gameId": context["gameId"],
            "treeComparisons": tree_updates,
            "treeRevision": int(context["game"].get("treeRevision", 0)),
            "timestamp": now_iso(),
        })
    _emit_auto_analysis_progress()
    _schedule_next_auto_analysis_item(generation)


def _on_auto_decision_complete(generation, item, future):
    try:
        result = future.result()
        _complete_auto_analysis_item(generation, item, result=result)
    except Exception as exc:  # pylint: disable=broad-except
        _complete_auto_analysis_item(generation, item, error=exc)


def _on_auto_opponent_analysis_complete(generation, item, result):
    status = str(result.get("status") or "") if isinstance(result, dict) else ""
    error = None if status == "ready" else status or "对手分析未返回结果"
    _complete_auto_analysis_item(generation, item, result=result, error=error)


def _extend_auto_analysis_plan(context):
    items = _build_auto_analysis_plan(context["game"], context["seat"], context["modelPath"])
    new_items = [item for item in items if auto_analysis_plan.item_key(item) not in context["known"]]
    for item in new_items:
        context["known"].add(auto_analysis_plan.item_key(item))
        AUTO_ANALYSIS_RUNTIME.status["total"] += 1
        if item["cached"]:
            AUTO_ANALYSIS_RUNTIME.status["completed"] += 1
            AUTO_ANALYSIS_RUNTIME.status["cached"] += 1
        elif _auto_analysis_kind_enabled(item["kind"]):
            context["pending"].append(item)
    context["treeRevision"] = int(context["game"].get("treeRevision", 0))
    return bool(new_items)


def reprioritize_auto_analysis_from_node(game, start_node_id, expected_serial=None):
    changed = False
    cached_updates = False
    with AUTO_ANALYSIS_RUNTIME.lock:
        context = AUTO_ANALYSIS_RUNTIME.context
        if (
            not isinstance(context, dict)
            or AUTO_ANALYSIS_RUNTIME.status.get("status") != "running"
            or context.get("game") is not game
        ):
            return False
        if expected_serial is not None and expected_serial != AUTO_ANALYSIS_RUNTIME.reprioritize_serial:
            return False

        if context.get("treeRevision") != int(game.get("treeRevision", 0)):
            changed = _extend_auto_analysis_plan(context) or changed

        context_generation = context.get("generation")

    # Topology traversal can be expensive for large branched records. Keep it
    # outside the lock used by status and navigation responses.
    navigation_rank = auto_analysis_plan.navigation_rank(game, start_node_id)

    with AUTO_ANALYSIS_RUNTIME.lock:
        context = AUTO_ANALYSIS_RUNTIME.context
        if (
            not isinstance(context, dict)
            or context.get("generation") != context_generation
            or context.get("game") is not game
            or AUTO_ANALYSIS_RUNTIME.status.get("status") != "running"
        ):
            return False
        if expected_serial is not None and expected_serial != AUTO_ANALYSIS_RUNTIME.reprioritize_serial:
            return False

        pending = []
        for item in context["pending"]:
            item_key = auto_analysis_plan.item_key(item)
            if item_key in context["attempted"]:
                changed = True
                continue
            if auto_analysis_plan.item_is_cached(game, item):
                context["attempted"].add(item_key)
                AUTO_ANALYSIS_RUNTIME.status["completed"] += 1
                AUTO_ANALYSIS_RUNTIME.status["cached"] += 1
                cached_updates = True
                changed = True
                continue
            if not _auto_analysis_kind_enabled(item["kind"]):
                changed = True
                continue
            pending.append(item)

        fallback_rank = len(navigation_rank)
        reordered = sorted(
            enumerate(pending),
            key=lambda entry: (
                navigation_rank.get(entry[1].get("nodeId"), fallback_rank),
                entry[0],
            ),
        )
        next_pending = deque(item for _index, item in reordered)
        if [auto_analysis_plan.item_key(item) for item in next_pending] != [
            auto_analysis_plan.item_key(item) for item in context["pending"]
            if auto_analysis_plan.item_key(item) not in context["attempted"]
        ]:
            changed = True
        context["pending"] = next_pending

    if cached_updates:
        _emit_auto_analysis_progress()
    return changed


def schedule_auto_analysis_reprioritization(game, start_node_id):
    with AUTO_ANALYSIS_RUNTIME.lock:
        context = AUTO_ANALYSIS_RUNTIME.context
        if (
            not isinstance(context, dict)
            or AUTO_ANALYSIS_RUNTIME.status.get("status") != "running"
            or context.get("game") is not game
        ):
            return False

        # The frame under the cursor remains first priority immediately. The
        # more expensive whole-record ordering waits until wheel input settles.
        focused = []
        remaining = []
        for item in context["pending"]:
            if item.get("nodeId") == start_node_id:
                focused.append(item)
            else:
                remaining.append(item)
        context["pending"] = deque(focused + remaining)

        previous_timer = AUTO_ANALYSIS_RUNTIME.reprioritize_timer
        AUTO_ANALYSIS_RUNTIME.reprioritize_serial += 1
        serial = AUTO_ANALYSIS_RUNTIME.reprioritize_serial

        def apply_settled_focus():
            with AUTO_ANALYSIS_RUNTIME.lock:
                if serial != AUTO_ANALYSIS_RUNTIME.reprioritize_serial:
                    return
                AUTO_ANALYSIS_RUNTIME.reprioritize_timer = None
            reprioritize_auto_analysis_from_node(
                game,
                start_node_id,
                expected_serial=serial,
            )

        timer = threading.Timer(AUTO_ANALYSIS_RUNTIME.reprioritize_delay_s, apply_settled_focus)
        timer.daemon = True
        AUTO_ANALYSIS_RUNTIME.reprioritize_timer = timer

    if previous_timer is not None:
        previous_timer.cancel()
    timer.start()
    return True


def _schedule_next_auto_analysis_item(generation):
    while True:
        with _STATE_LOCK:
            with AUTO_ANALYSIS_RUNTIME.lock:
                context = AUTO_ANALYSIS_RUNTIME.context
                if (
                    not isinstance(context, dict)
                    or context.get("generation") != generation
                    or AUTO_ANALYSIS_RUNTIME.status.get("status") != "running"
                    or STATE.get("game") is not context.get("game")
                ):
                    return
                game = context["game"]
                while context["pending"]:
                    item = context["pending"].popleft()
                    if auto_analysis_plan.item_is_cached(game, item):
                        context["attempted"].add(auto_analysis_plan.item_key(item))
                        AUTO_ANALYSIS_RUNTIME.status["completed"] += 1
                        AUTO_ANALYSIS_RUNTIME.status["cached"] += 1
                        continue
                    if not _auto_analysis_kind_enabled(item["kind"]):
                        continue
                    AUTO_ANALYSIS_RUNTIME.status["currentNodeId"] = item["nodeId"]
                    AUTO_ANALYSIS_RUNTIME.status["currentModel"] = item["kind"]
                    break
                else:
                    item = None

                if item is None:
                    if _extend_auto_analysis_plan(context) and context["pending"]:
                        continue
                    failed = int(AUTO_ANALYSIS_RUNTIME.status["failed"])
                    completed = int(AUTO_ANALYSIS_RUNTIME.status["completed"])
                    total = int(AUTO_ANALYSIS_RUNTIME.status["total"])
                    AUTO_ANALYSIS_RUNTIME.status.update({
                        "status": "completed",
                        "currentNodeId": None,
                        "currentModel": None,
                        "message": (
                            f"完成，{failed} 项失败"
                            if failed
                            else "分析完成" if completed == total else "可用模型分析完成"
                        ),
                    })
                    AUTO_ANALYSIS_RUNTIME.context = None
                    AUTO_ANALYSIS_RUNTIME.future = None
                    finished = True
                else:
                    finished = False
                    seat = context["seat"]
                    model_path = context["modelPath"]
                    game_id = context["gameId"]

        if finished:
            _emit_auto_analysis_progress()
            return

        if item["kind"] == "decision":
            future = _BG_EXECUTOR.submit(
                _run_auto_decision_item,
                game,
                item,
                seat,
                model_path,
            )
            with AUTO_ANALYSIS_RUNTIME.lock:
                if (
                    isinstance(AUTO_ANALYSIS_RUNTIME.context, dict)
                    and AUTO_ANALYSIS_RUNTIME.context.get("generation") == generation
                ):
                    AUTO_ANALYSIS_RUNTIME.future = future
            future.add_done_callback(
                lambda completed_future, g=generation, current_item=item: (
                    _on_auto_decision_complete(g, current_item, completed_future)
                )
            )
            _emit_auto_analysis_progress()
            return

        input_mode = str(item.get("inputMode") or "public")
        opponent_context = {
            "gameId": game_id,
            "nodeId": item["nodeId"],
            "seat": seat,
            "inputMode": input_mode,
            "cacheKey": item["cacheKey"],
            "cacheEpoch": _OPPONENT_ANALYSIS_CACHE_EPOCH,
            "autoAnalysisGeneration": generation,
        }
        try:
            prediction_bundle = get_cached_mjai_stream_bundle(
                game,
                item["nodeId"],
                seat,
                reveal_all=input_mode == "full-information",
            )
            target_bundle = get_cached_mjai_stream_bundle(
                game,
                item["nodeId"],
                seat,
                reveal_all=True,
            )
        except Exception as exc:  # pylint: disable=broad-except
            with AUTO_ANALYSIS_RUNTIME.lock:
                context = AUTO_ANALYSIS_RUNTIME.context
                still_current = (
                    isinstance(context, dict)
                    and context.get("generation") == generation
                    and context.get("game") is game
                    and AUTO_ANALYSIS_RUNTIME.status.get("status") == "running"
                )
            if still_current:
                _complete_auto_analysis_item(generation, item, error=exc)
            return
        with AUTO_ANALYSIS_RUNTIME.lock:
            context = AUTO_ANALYSIS_RUNTIME.context
            still_current = (
                isinstance(context, dict)
                and context.get("generation") == generation
                and context.get("game") is game
                and AUTO_ANALYSIS_RUNTIME.status.get("status") == "running"
            )
        if not still_current:
            return
        accepted = OPPONENT_PREDICTIONS.request_background_predict(
            game["nodes"][item["nodeId"]]["snapshot"],
            seat,
            input_mode=input_mode,
            context=opponent_context,
            on_complete=lambda result, g=generation, current_item=item: (
                _on_auto_opponent_analysis_complete(g, current_item, result)
            ),
            mjai_events=prediction_bundle["events"],
            mjai_prefix_hashes=prediction_bundle["prefixHashes"],
            mjai_events_hash=prediction_bundle["eventHash"],
            target_mjai_events=target_bundle["events"],
            target_mjai_prefix_hashes=target_bundle["prefixHashes"],
            target_mjai_events_hash=target_bundle["eventHash"],
        )
        if accepted:
            _emit_auto_analysis_progress()
            return

        if not _auto_analysis_kind_enabled("opponent"):
            _schedule_next_auto_analysis_item(generation)
            return

        _complete_auto_analysis_item(
            generation,
            item,
            error=OPPONENT_PREDICTIONS.activity_error() or "对手分析任务重复",
        )
        return


def start_auto_analysis():
    ensure_game_loaded()
    cancel_auto_analysis(emit_progress=False)
    game = STATE["game"]
    seat = int(STATE["controlledSeat"])
    model_path = get_action_engine_weight_path()
    items = _build_auto_analysis_plan(game, seat, model_path)
    cached_count = sum(1 for item in items if item["cached"])
    pending = deque(
        item
        for item in items
        if not item["cached"] and _auto_analysis_kind_enabled(item["kind"])
    )

    with AUTO_ANALYSIS_RUNTIME.lock:
        AUTO_ANALYSIS_RUNTIME.generation += 1
        generation = AUTO_ANALYSIS_RUNTIME.generation
        AUTO_ANALYSIS_RUNTIME.future = None
        AUTO_ANALYSIS_RUNTIME.context = {
            "generation": generation,
            "game": game,
            "gameId": game.get("gameId"),
            "seat": seat,
            "modelPath": model_path,
            "pending": pending,
            "known": {auto_analysis_plan.item_key(item) for item in items},
            "attempted": set(),
            "treeRevision": int(game.get("treeRevision", 0)),
        }
        AUTO_ANALYSIS_RUNTIME.status.update({
            "status": "running",
            "completed": cached_count,
            "total": len(items),
            "cached": cached_count,
            "analyzed": 0,
            "failed": 0,
            "currentNodeId": None,
            "currentModel": None,
            "message": "",
        })

    _emit_auto_analysis_progress()
    _schedule_next_auto_analysis_item(generation)
    return get_auto_analysis_status()


def tree_node_is_visible_to_seat(node, seat):
    if node.get("type") != "decision" and not (node.get("action") or {}).get("decisionOnly"):
        return True
    try:
        actor = normalize_seat((node.get("action") or {}).get("actor"))
    except (TypeError, ValueError):
        return False
    return actor == normalize_seat(seat)


def resolve_visible_tree_cursor(game, node_id, seat):
    nodes = game.get("nodes") or {}
    node = nodes.get(node_id)
    if not isinstance(node, dict) or tree_node_is_visible_to_seat(node, seat):
        return node_id

    visited = set()
    cursor_id = node_id
    while cursor_id in nodes and cursor_id not in visited:
        visited.add(cursor_id)
        cursor = nodes[cursor_id]
        main_child_id = cursor.get("mainChildId")
        if main_child_id not in nodes:
            break
        if tree_node_is_visible_to_seat(nodes[main_child_id], seat):
            return main_child_id
        cursor_id = main_child_id

    cursor_id = node.get("parentId")
    while cursor_id in nodes and cursor_id not in visited:
        visited.add(cursor_id)
        cursor = nodes[cursor_id]
        if tree_node_is_visible_to_seat(cursor, seat):
            return cursor_id
        cursor_id = cursor.get("parentId")
    return node_id


def normalize_current_tree_cursor(game, seat):
    current_node_id = game.get("currentNodeId")
    visible_node_id = resolve_visible_tree_cursor(game, current_node_id, seat)
    if visible_node_id != current_node_id:
        game["currentNodeId"] = visible_node_id
        game["pendingReview"] = None
    return game.get("currentNodeId")


def build_tree_view(game, current_node_id):
    round_root_cache = {}
    round_depth_cache = {}
    projected_parent_cache = {}
    projected_children_cache = {}
    projected_main_child_cache = {}
    controlled_seat = STATE["controlledSeat"]

    def is_visible(node_id):
        node = game["nodes"].get(node_id)
        return isinstance(node, dict) and tree_node_is_visible_to_seat(node, controlled_seat)

    def resolve_is_decision(node):
        cached = node.get("isDecision")
        if isinstance(cached, bool):
            return cached
        action = node.get("action") or {}
        try:
            actor = normalize_seat(action.get("actor"))
        except (TypeError, ValueError):
            return False
        if actor != STATE["controlledSeat"]:
            return False
        parent_id = node.get("parentId")
        if parent_id not in game["nodes"]:
            return False
        value = len(
            get_node_legal_actions(
                game,
                parent_id,
                controlled_seat=actor,
            )
        ) > 1
        node["isDecision"] = value
        return value

    def resolve_round_root_id(node_id):
        if node_id in round_root_cache:
            return round_root_cache[node_id]
        path = []
        cursor_id = node_id
        while True:
            cached_root = round_root_cache.get(cursor_id)
            if cached_root is not None:
                round_root_id = cached_root
                break

            node = game["nodes"][cursor_id]
            path.append(cursor_id)
            parent_id = node.get("parentId")
            if not parent_id:
                round_root_id = cursor_id
                break

            parent_node = game["nodes"].get(parent_id)
            if not parent_node or parent_node.get("type") == "root":
                round_root_id = cursor_id
                break

            snapshot = node["snapshot"]
            parent_snapshot = parent_node["snapshot"]
            if (
                int(parent_snapshot.get("roundIndex", -1))
                != int(snapshot.get("roundIndex", 0))
                or int(parent_snapshot.get("honba", -1))
                != int(snapshot.get("honba", 0))
            ):
                round_root_id = cursor_id
                break
            cursor_id = parent_id

        for path_node_id in path:
            round_root_cache[path_node_id] = round_root_id
        return round_root_id

    def resolve_projected_parent_id(node_id):
        if node_id in projected_parent_cache:
            return projected_parent_cache[node_id]
        parent_id = game["nodes"][node_id].get("parentId")
        visited = set()
        while parent_id in game["nodes"] and parent_id not in visited:
            visited.add(parent_id)
            if is_visible(parent_id):
                projected_parent_cache[node_id] = parent_id
                return parent_id
            parent_id = game["nodes"][parent_id].get("parentId")
        projected_parent_cache[node_id] = parent_id
        return parent_id

    def resolve_projected_children(node_id):
        if node_id in projected_children_cache:
            return projected_children_cache[node_id][:]
        result = []
        seen = set()

        def collect(child_id, path):
            if child_id not in game["nodes"] or child_id in path:
                return
            if is_visible(child_id):
                if child_id not in seen:
                    seen.add(child_id)
                    result.append(child_id)
                return
            child = game["nodes"][child_id]
            next_path = path | {child_id}
            for grandchild_id in child.get("children", []):
                collect(grandchild_id, next_path)

        for child_id in game["nodes"][node_id].get("children", []):
            collect(child_id, {node_id})
        projected_children_cache[node_id] = result[:]
        return result

    def resolve_projected_main_child_id(node_id):
        if node_id in projected_main_child_cache:
            return projected_main_child_cache[node_id]
        child_id = game["nodes"][node_id].get("mainChildId")
        visited = {node_id}
        while child_id in game["nodes"] and child_id not in visited:
            visited.add(child_id)
            if is_visible(child_id):
                projected_main_child_cache[node_id] = child_id
                return child_id
            child_id = game["nodes"][child_id].get("mainChildId")
        projected_main_child_cache[node_id] = None
        return None

    def resolve_round_depth(node_id):
        if node_id in round_depth_cache:
            return round_depth_cache[node_id]
        round_root_id = resolve_round_root_id(node_id)
        if node_id == round_root_id:
            round_depth = 1
        else:
            parent_id = resolve_projected_parent_id(node_id)
            if (
                parent_id in game["nodes"]
                and game["nodes"][parent_id].get("type") != "root"
                and resolve_round_root_id(parent_id) == round_root_id
            ):
                round_depth = resolve_round_depth(parent_id) + 1
            else:
                round_depth = 1
        round_depth_cache[node_id] = round_depth
        return round_depth

    current_round_root_id = resolve_round_root_id(current_node_id)

    nodes = []
    round_root_ids = []
    round_children_map = {}
    round_parent_map = {}
    round_main_next_map = {}
    round_summary_cache = {}

    for node_id, node in game["nodes"].items():
        if node.get("type") == "root":
            continue
        round_root_id = resolve_round_root_id(node_id)
        if round_root_id == node_id:
            round_root_ids.append(node_id)
        if round_root_id != current_round_root_id or not is_visible(node_id):
            continue
        snapshot = node["snapshot"]
        round_depth = resolve_round_depth(node_id)
        round_index = int(snapshot.get("roundIndex", 0))
        bakaze = snapshot.get("bakaze")
        kyoku = snapshot.get("kyoku")
        honba = int(snapshot.get("honba", 0))
        kyotaku = int(snapshot.get("kyotaku", 0))
        scores = copy.deepcopy(snapshot.get("scores", [25000, 25000, 25000, 25000]))
        nodes.append(
            {
                "id": node_id,
                "parentId": resolve_projected_parent_id(node_id),
                "children": resolve_projected_children(node_id),
                "mainChildId": resolve_projected_main_child_id(node_id),
                "depth": node["depth"],
                "roundDepth": round_depth,
                "roundRootId": round_root_id,
                "roundIndex": round_index,
                "bakaze": bakaze,
                "kyoku": kyoku,
                "honba": honba if node.get("type") != "root" else 0,
                "kyotaku": kyotaku if node.get("type") != "root" else 0,
                "scores": scores if node.get("type") != "root" else [25000, 25000, 25000, 25000],
                "phase": node.get("snapshot", {}).get("phase"),
                "type": node["type"],
                "action": node["action"],
                "isDecision": resolve_is_decision(node),
                "comparison": copy.deepcopy(node.get("comparison")),
                "isCurrent": node_id == current_node_id,
            }
        )
    nodes.sort(key=lambda item: (item["depth"], item["id"]))

    round_root_ids.sort(key=lambda node_id: (game["nodes"][node_id]["depth"], node_id))

    for round_root_id in round_root_ids:
        round_root_node = game["nodes"][round_root_id]
        snapshot = round_root_node["snapshot"]
        round_summary_cache[round_root_id] = {
            "id": round_root_id,
            "parentRoundId": None,
            "childRoundIds": [],
            "mainNextRoundId": None,
            "depth": round_root_node["depth"],
            "roundIndex": int(snapshot.get("roundIndex", 0)),
            "bakaze": snapshot.get("bakaze"),
            "kyoku": snapshot.get("kyoku"),
            "honba": int(snapshot.get("honba", 0)),
            "kyotaku": int(snapshot.get("kyotaku", 0)),
            "scores": copy.deepcopy(snapshot.get("scores", [25000, 25000, 25000, 25000])),
            "phase": snapshot.get("phase"),
            "isCurrent": round_root_id == current_round_root_id,
        }

    for round_root_id in round_root_ids:
        cursor_id = round_root_id
        next_round_id = None
        result_info = None
        match_end_info = None
        tail_scores = copy.deepcopy(round_summary_cache[round_root_id]["scores"])
        tail_phase = round_summary_cache[round_root_id]["phase"]
        while cursor_id:
            cursor_node = game["nodes"].get(cursor_id)
            if not cursor_node:
                break
            cursor_snapshot = cursor_node.get("snapshot", {})
            tail_scores = copy.deepcopy(cursor_snapshot.get("scores", tail_scores))
            tail_phase = cursor_snapshot.get("phase", tail_phase)
            result_action_type = (cursor_snapshot.get("lastAction") or {}).get("type")
            if result_action_type == "round_result":
                result_info = build_result_info(copy.deepcopy(cursor_snapshot))
            elif result_action_type in ("match_result", "match_end"):
                match_end_info = build_result_info(copy.deepcopy(cursor_snapshot))
            main_child_id = cursor_node.get("mainChildId")
            if not main_child_id:
                break
            child_round_id = resolve_round_root_id(main_child_id)
            if child_round_id != round_root_id:
                next_round_id = child_round_id
                break
            cursor_id = main_child_id
        round_main_next_map[round_root_id] = next_round_id
        round_summary_cache[round_root_id]["mainNextRoundId"] = next_round_id
        round_summary_cache[round_root_id]["resultInfo"] = result_info
        round_summary_cache[round_root_id]["matchEndInfo"] = match_end_info
        round_summary_cache[round_root_id]["tailScores"] = tail_scores
        round_summary_cache[round_root_id]["tailPhase"] = tail_phase

    round_child_seen = {round_root_id: set() for round_root_id in round_root_ids}
    for node_id, node in game["nodes"].items():
        if node.get("type") == "root":
            continue
        round_root_id = resolve_round_root_id(node_id)
        child_round_ids = round_children_map.setdefault(round_root_id, [])
        seen = round_child_seen.setdefault(round_root_id, set())
        for child_id in node.get("children", []):
            if child_id not in game["nodes"]:
                continue
            child_round_id = resolve_round_root_id(child_id)
            if child_round_id == round_root_id or child_round_id in seen:
                continue
            seen.add(child_round_id)
            child_round_ids.append(child_round_id)
            round_parent_map.setdefault(child_round_id, round_root_id)

    for round_root_id in round_root_ids:
        child_round_ids = round_children_map.get(round_root_id, [])
        round_summary_cache[round_root_id]["childRoundIds"] = child_round_ids[:]

    for round_root_id, parent_round_id in round_parent_map.items():
        if round_root_id in round_summary_cache:
            round_summary_cache[round_root_id]["parentRoundId"] = parent_round_id

    return {
        "rootNodeId": game["rootNodeId"],
        "currentNodeId": current_node_id,
        "mainLeafNodeId": game["mainLeafNodeId"],
        "currentRoundRootId": current_round_root_id,
        "revision": int(game.get("treeRevision", 0)),
        "viewSeat": controlled_seat,
        "compact": False,
        "nodes": nodes,
        "rounds": [round_summary_cache[round_root_id] for round_root_id in round_root_ids],
    }


def build_tree_cursor_view(game, current_node_id):
    return {
        "rootNodeId": game["rootNodeId"],
        "currentNodeId": current_node_id,
        "mainLeafNodeId": game["mainLeafNodeId"],
        "currentRoundRootId": resolve_round_root_id_for_node(game, current_node_id),
        "revision": int(game.get("treeRevision", 0)),
        "viewSeat": int(STATE["controlledSeat"]),
        "compact": True,
    }


def rank_scores(scores):
    normalized = [
        int(scores[seat]) if isinstance(scores, (list, tuple)) and seat < len(scores) else 0
        for seat in range(4)
    ]
    absolute_by_rank = sorted(range(4), key=lambda seat: (-normalized[seat], seat))
    ranks = [0, 0, 0, 0]
    for rank, seat in enumerate(absolute_by_rank, start=1):
        ranks[seat] = rank
    return ranks


def build_result_info(snapshot):
    sync_snapshot_state(snapshot)
    last_action = snapshot.get("lastAction") or {}
    action_type = last_action.get("type")
    diff_to_controlled = [(seat - STATE["controlledSeat"] + 4) % 4 for seat in range(4)]
    relative_labels = ["自家", "下家", "对家", "上家"]
    seat_names = [relative_labels[diff_to_controlled[seat]] for seat in range(4)]

    if action_type == "round_result":
        result = copy.deepcopy(last_action.get("result") or {})
        event_type = result.get("eventType", "round_result")
        event_data = copy.deepcopy(result.get("eventData") or {})
        if event_type == "hora":
            hora_actor = int(event_data.get("actor", snapshot.get("dealer", 0)))
            hora_target = int(event_data.get("target", hora_actor))
            scores = copy.deepcopy(result.get("scores", snapshot.get("scores", [25000, 25000, 25000, 25000])))
            return {
                "eventType": "round_result",
                "title": f"{seat_names[hora_actor]} {'自摸' if hora_actor == hora_target else '荣和 ' + seat_names[hora_target]}",
                "detail": "",
                "reason": None,
                "scores": scores,
                "ranks": rank_scores(scores),
                "deltas": copy.deepcopy(event_data.get("deltas", [0, 0, 0, 0])),
                "actor": hora_actor,
                "target": hora_target,
                "han": event_data.get("han"),
                "fu": event_data.get("fu"),
                "yaku": copy.deepcopy(event_data.get("yaku", [])),
                "yakuDetails": copy.deepcopy(event_data.get("yakuDetails", [])),
                "uraMarkers": copy.deepcopy(event_data.get("uraMarkers", [])),
                "isOpenHand": event_data.get("isOpenHand"),
                "cost": copy.deepcopy(event_data.get("cost", {})),
            }
        if event_type == "ryukyoku":
            reason_label = str(event_data.get("reasonLabel") or "")
            reason = str(event_data.get("reason") or "")
            reason_titles = {
                "exhaustive_draw": "荒牌流局",
                "kyuushu_kyuuhai": "九种九牌",
                "suufon_renda": "四风连打",
                "suukantsu": "四杠散了",
                "suucha_riichi": "四家立直",
            }
            label_titles = {
                "": "荒牌流局",
                "流局": "荒牌流局",
                "九種九牌": "九种九牌",
                "四風連打": "四风连打",
                "四槓散了": "四杠散了",
            }
            title = reason_titles.get(reason) or label_titles.get(reason_label, reason_label)
            scores = copy.deepcopy(result.get("scores", snapshot.get("scores", [25000, 25000, 25000, 25000])))
            return {
                "eventType": "round_result",
                "title": title,
                "detail": "",
                "reason": reason,
                "scores": scores,
                "ranks": rank_scores(scores),
                "deltas": copy.deepcopy(event_data.get("deltas", [0, 0, 0, 0])),
            }
        scores = copy.deepcopy(snapshot.get("scores", [25000, 25000, 25000, 25000]))
        return {
            "eventType": "round_result",
            "title": "结算",
            "detail": "",
            "reason": None,
            "scores": scores,
            "ranks": rank_scores(scores),
            "deltas": copy.deepcopy(result.get("deltas", [0, 0, 0, 0])),
        }
    if action_type in ("match_result", "match_end"):
        result = copy.deepcopy(last_action.get("result") or {})
        if action_type == "match_end" and not result.get("scores"):
            for history_action in reversed(snapshot.get("actionHistory") or []):
                if history_action.get("type") != "round_result":
                    continue
                result = copy.deepcopy(history_action.get("result") or {})
                break
        scores = copy.deepcopy(result.get("scores", snapshot.get("scores", [25000, 25000, 25000, 25000])))
        return {
            "eventType": "match_end",
            "title": "终局",
            "detail": f"{result.get('bakaze', 'W')}{result.get('kyoku', 4)} 结束",
            "reason": None,
            "scores": scores,
            "ranks": rank_scores(scores),
            "deltas": [0, 0, 0, 0],
        }
    return None


def resolve_last_drawn_tile(snapshot, seat):
    sync_snapshot_state(snapshot)
    if snapshot.get("currentActor") != seat:
        return None

    if snapshot.get("phase") == "game_end":
        last_action = snapshot.get("lastAction") or {}
        if last_action.get("type") == "hora" and last_action.get("actor") == seat:
            if last_action.get("isTsumo", last_action.get("actor") == last_action.get("target")):
                return str(last_action.get("pai") or "")
        return None

    if snapshot.get("phase") not in ("discard", "draw_or_discard", "reach_declaration", "round_result"):
        return None

    for action in reversed(snapshot.get("actionHistory", [])):
        if int(action.get("actor", -1)) != seat:
            continue
        action_type = str(action.get("type") or "")
        if action_type == "tsumo":
            return str(action.get("pai") or "")
        if action_type in ("chi", "pon", "daiminkan", "ankan", "kakan", "dahai", "hora", "ryukyoku"):
            return None

    return None


def resolve_display_last_draw_state(snapshot):
    sync_snapshot_state(snapshot)
    last_action = snapshot.get("lastAction") or {}
    phase = snapshot.get("phase")

    if phase == "game_end" and last_action.get("type") == "hora":
        winner = int(last_action.get("actor", -1))
        target = int(last_action.get("target", winner))
        if winner >= 0 and last_action.get("isTsumo", winner == target):
            tile = str(last_action.get("pai") or "")
            return winner, tile or None
        return None, None

    if phase == "round_result" and last_action.get("type") == "round_result":
        result = last_action.get("result") or {}
        if result.get("eventType") == "hora":
            event_data = result.get("eventData") or {}
            winner = int(event_data.get("actor", -1))
            target = int(event_data.get("target", winner))
            if winner >= 0 and winner == target:
                tile = str(event_data.get("pai") or "")
                return winner, tile or None

    current_actor = snapshot.get("currentActor")
    if current_actor is None:
        return None, None
    tile = resolve_last_drawn_tile(snapshot, current_actor)
    if tile:
        return int(current_actor), tile
    return None, None


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
    controlled_seat = STATE["controlledSeat"]
    last_drawn_seat, last_drawn_tile = resolve_display_last_draw_state(snapshot)
    hands_view = []
    revealed_seats = set()
    last = snapshot.get("lastAction") or {}
    if last.get("type") == "hora":
        revealed_seats.add(int(last.get("actor", -1)))
    elif last.get("type") == "ryukyoku":
        for s in last.get("tenpaiSeats", []):
            revealed_seats.add(int(s))
    elif last.get("type") == "round_result":
        result = last.get("result") or {}
        event_data = result.get("eventData") or {}
        event_type = result.get("eventType")
        if event_type == "hora":
            revealed_seats.add(int(event_data.get("actor", -1)))
        elif event_type == "ryukyoku":
            for s in event_data.get("tenpaiSeats", []):
                revealed_seats.add(int(s))
    for seat, hand in enumerate(snapshot["hands"]):
        if seat == controlled_seat or STATE["visibleHands"] or seat in revealed_seats:
            hands_view.append(hand[:])
        else:
            hands_view.append(["?"] * len(hand))

    return {
        "matchId": STATE["game"].get("matchId") if STATE.get("game") else None,
        "bakaze": snapshot["bakaze"],
        "kyoku": snapshot["kyoku"],
        "honba": snapshot["honba"],
        "kyotaku": snapshot["kyotaku"],
        "roundIndex": snapshot["roundIndex"],
        "westEntered": snapshot.get("westEntered", False),
        "dealer": snapshot["dealer"],
        "currentActor": snapshot["currentActor"],
        "phase": snapshot["phase"],
        "turn": snapshot["turn"],
        "drawIndex": snapshot["drawIndex"],
        "lastDrawnSeat": last_drawn_seat,
        "lastDrawnTile": last_drawn_tile,
        "autoAdvanceMode": resolve_auto_advance_mode(snapshot),
        "wallRemaining": len(snapshot["wall"]) - snapshot["drawIndex"],
        "doraIndicators": snapshot["doraIndicators"][:],
        "uraIndicators": snapshot.get("uraIndicators", [])[:],
        "scores": snapshot["scores"][:],
        "hands": hands_view,
        "rivers": copy.deepcopy(snapshot["rivers"]),
        "melds": copy.deepcopy(snapshot["melds"]),
        "actionHistory": copy.deepcopy(snapshot.get("actionHistory", [])),
        "riichiDeclared": copy.deepcopy(snapshot.get("riichiDeclared", [False, False, False, False])),
        "riichiAccepted": copy.deepcopy(snapshot.get("riichiAccepted", [False, False, False, False])),
        "ippatsuEligible": copy.deepcopy(snapshot.get("ippatsuEligible", [False, False, False, False])),
        "pendingRiichiSeat": snapshot.get("pendingRiichiSeat"),
        "riichiDiscardState": snapshot.get("riichiDiscardState"),
        "pendingRiichiDiscard": copy.deepcopy(snapshot.get("pendingRiichiDiscard")),
        "pendingKan": copy.deepcopy(snapshot.get("pendingKan")),
        "pendingDiscard": copy.deepcopy(snapshot["pendingDiscard"]),
        "reactionWindow": copy.deepcopy(snapshot["reactionWindow"]),
        "kanReactionWindow": copy.deepcopy(snapshot.get("kanReactionWindow")),
        "lastAction": copy.deepcopy(snapshot["lastAction"]),
        "resultInfo": build_result_info(snapshot),
    }


def build_match_summary(game, snapshot):
    match_state = copy.deepcopy(game.get("matchState") or snapshot.get("matchState") or {})
    sync_snapshot_state(snapshot)
    match_state["bakaze"] = snapshot["bakaze"]
    match_state["kyoku"] = snapshot["kyoku"]
    match_state["honba"] = snapshot["honba"]
    match_state["kyotaku"] = snapshot["kyotaku"]
    match_state["dealer"] = snapshot["dealer"]
    match_state["scores"] = copy.deepcopy(snapshot["scores"])
    match_state["roundIndex"] = snapshot["roundIndex"]
    match_state["westEntered"] = snapshot.get("westEntered", False)
    return {
        "matchId": game.get("matchId") or game.get("gameId"),
        "matchType": (game.get("matchConfig") or {}).get("matchType", "hanchan"),
        "roundIndex": match_state.get("roundIndex", 0),
        "bakaze": match_state.get("bakaze", "E"),
        "kyoku": match_state.get("kyoku", 1),
        "honba": match_state.get("honba", 0),
        "kyotaku": match_state.get("kyotaku", 0),
        "scores": copy.deepcopy(match_state.get("scores", [25000, 25000, 25000, 25000])),
        "dealer": match_state.get("dealer", 0),
        "westEntered": bool(match_state.get("westEntered", False)),
        "ended": bool(match_state.get("ended", False)),
    }


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
        opponent_analysis = get_current_opponent_analysis()
    legal_actions = get_node_legal_actions(game, current_node_id)
    if legal_actions and STATE.get("decisionRecommendationsEnabled", True):
        # Rendering a position must never wait for decision-engine inference. Cached results
        # are returned immediately; a miss is delivered later via analysis_ready.
        analysis = _get_or_schedule_analysis(current_node, snapshot, legal_actions)
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


def serialize_game_record():
    ensure_game_loaded()
    game_copy = copy.deepcopy(STATE["game"])
    state_copy = {
        "mode": STATE["mode"],
        "controlledSeat": STATE["controlledSeat"],
        "pendingSeatSwitch": STATE["pendingSeatSwitch"],
        "visibleHands": STATE["visibleHands"],
    }
    return serialize_game_record_parts(game_copy, state_copy)


def load_game_record(record):
    if not isinstance(record, dict):
        raise ValueError("Record must be an object.")
    format_version = int(record.get("formatVersion") or 0)
    if format_version not in (1, 2, 3):
        raise ValueError("Unsupported record format version.")

    game = record.get("game")
    state = record.get("state") or {}
    if not isinstance(game, dict) or not game.get("nodes"):
        raise ValueError("Record is missing game data.")

    hydrate_game_structure(game, format_version)
    hydrate_round_walls(game)

    game.setdefault("matchId", game.get("gameId", "game"))
    game.setdefault("metadata", {"label": game.get("matchId", game.get("gameId", "game")), "source": "imported-record"})
    game.setdefault(
        "matchConfig",
        {
            "matchType": "hanchan",
            "players": 4,
            "westEntryEnabled": True,
            "maxBakaze": "W",
            "maxKyoku": 4,
        },
    )
    if "matchState" not in game:
        root_snapshot = next(iter(game["nodes"].values()))["snapshot"]
        sync_snapshot_state(root_snapshot)
        game["matchState"] = copy.deepcopy(root_snapshot["matchState"])
        game["matchState"]["matchId"] = game["matchId"]
        game["matchState"]["seed"] = game.get("seed", 0)
        game["matchState"].setdefault("matchType", "hanchan")
        game["matchState"].setdefault("players", 4)
        game["matchState"].setdefault("westEntryEnabled", True)
        game["matchState"].setdefault("maxBakaze", "W")
        game["matchState"].setdefault("maxKyoku", 4)
        game["matchState"].setdefault("roundSeeds", build_round_seed_stream(random.Random(int(game.get("seed", 0)))))
    game.setdefault("pendingReview", None)
    game.setdefault("treeRevision", 1)
    repair_mortal_report_game(game)
    repair_tsumo_action_tiles(game)
    repair_reaction_decision_nodes(game)
    if game_tree.repair_main_branch_links(game):
        game["treeRevision"] = int(game.get("treeRevision", 0)) + 1
    migrate_analysis_cache_storage(game)
    static_match_fields = (
        "matchId",
        "matchType",
        "players",
        "westEntryEnabled",
        "maxBakaze",
        "maxKyoku",
        "seed",
        "roundSeeds",
    )
    for node in game["nodes"].values():
        snapshot = node["snapshot"]
        sync_snapshot_state(snapshot)
        snapshot_match_state = snapshot["matchState"]
        for field in static_match_fields:
            if field in game["matchState"]:
                snapshot_match_state[field] = copy.deepcopy(game["matchState"][field])
    _migrate_discard_tsumogiri(game)
    _migrate_terminal_table_scores(game)

    reset_runtime_for_game_change()
    reserve_loaded_game_id(game.get("gameId"))
    STATE["game"] = copy.deepcopy(game)
    STATE["gameLoaded"] = True
    STATE["mode"] = "research" if is_read_only_game(game) else normalize_mode(state.get("mode"))
    STATE["controlledSeat"] = normalize_seat(state.get("controlledSeat", 0))
    STATE["pendingSeatSwitch"] = None
    STATE["visibleHands"] = bool(state.get("visibleHands"))
    normalize_current_tree_cursor(STATE["game"], STATE["controlledSeat"])
    backfill_cached_child_comparisons(STATE["game"])
    if STATE["mode"] == "research":
        request_current_opponent_analysis()


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
            "decision": get_decision_response_ms(),
            "opponentAnalysis": OPPONENT_PREDICTIONS.average_response_ms(),
        },
        "analysisVisibility": {
            "decisionRecommendations": bool(STATE.get("decisionRecommendationsEnabled", True)),
            "opponentAnalysis": bool(STATE.get("opponentAnalysisEnabled", False)),
        },
        "modelActivity": {
            "decision": get_decision_activity(),
            "opponentAnalysis": OPPONENT_PREDICTIONS.activity_state(),
            "errors": {
                "decision": get_decision_activity_errors(),
                "opponentAnalysis": OPPONENT_PREDICTIONS.activity_error(),
            },
        },
        "modelRuntime": {
            "decision": ACTION_RECOMMENDATIONS.runtime_status(),
            "opponentAnalysis": OPPONENT_PREDICTIONS.runtime_status(),
        },
        "autoAnalysis": get_auto_analysis_status(
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


def draw_one(snapshot, seat):
    sync_snapshot_state(snapshot)
    return draw_tile(snapshot, seat, source="wall")


def draw_tile(snapshot, seat, source="wall"):
    sync_snapshot_state(snapshot)
    if source == "rinshan":
        if not has_rinshan_draw_available(snapshot):
            raise ValueError("Rinshan exhausted.")
        tile = snapshot["rinshanWall"][0]
        snapshot["rinshanWall"] = snapshot["rinshanWall"][1:]
        # 开杠摸岭上牌：王牌区向牌山区扩张一格，牌山最后一张变为不可摸
        if snapshot["drawIndex"] < len(snapshot["wall"]):
            snapshot["wall"] = snapshot["wall"][:-1]
    else:
        if snapshot["drawIndex"] >= len(snapshot["wall"]):
            raise ValueError("Wall exhausted.")
        tile = snapshot["wall"][snapshot["drawIndex"]]
        snapshot["drawIndex"] += 1
    snapshot["hands"][seat].append(tile)
    snapshot["hands"][seat] = sort_tiles(snapshot["hands"][seat])
    snapshot["lastAction"] = {
        "type": "tsumo",
        "actor": seat,
        "pai": tile,
        "source": source,
    }
    snapshot["actionHistory"].append(
        {
            "type": "tsumo",
            "actor": seat,
            "pai": tile,
            "tsumogiri": False,
            "source": source,
        }
    )
    persist_snapshot_state(snapshot)
    return tile


def has_pending_riichi(snapshot, actor):
    return snapshot.get("pendingRiichiSeat") == actor and not snapshot["riichiAccepted"][actor]


def stage_riichi_discard(snapshot, actor, tile, tsumogiri):
    next_actor = (actor + 1) % 4
    snapshot["pendingRiichiDiscard"] = {
        "actor": actor,
        "pai": tile,
        "tsumogiri": tsumogiri,
        "targetActor": next_actor,
        "riichi": True,
    }
    snapshot["reactionWindow"] = None
    snapshot["lastAction"] = {
        "type": "reach",
        "actor": actor,
    }
    snapshot["phase"] = "reach_declaration"
    persist_snapshot_state(snapshot)


def materialize_reach_discard(snapshot):
    sync_snapshot_state(snapshot)
    staged = snapshot.get("pendingRiichiDiscard")
    if not staged:
        return False
    actor = staged["actor"]
    tile = staged["pai"]
    return materialize_reach_declaration_discard(snapshot, actor, tile, bool(staged.get("tsumogiri", False)))


def materialize_reach_declaration_discard(snapshot, actor, tile, tsumogiri):
    sync_snapshot_state(snapshot)
    if tile in snapshot["hands"][actor]:
        snapshot["hands"][actor].remove(tile)
    promote_delayed_dora_reveal(snapshot)
    snapshot["pendingDiscard"] = {
        "actor": actor,
        "pai": tile,
        "tsumogiri": bool(tsumogiri),
        "targetActor": (actor + 1) % 4,
        "riichi": True,
    }
    snapshot["pendingRiichiDiscard"] = None
    snapshot["reactionWindow"] = None
    snapshot["lastAction"] = {
        "type": "dahai",
        "actor": actor,
        "pai": tile,
        "tsumogiri": bool(tsumogiri),
        "riichi": True,
    }
    snapshot["actionHistory"].append(
        {
            "type": "dahai",
            "actor": actor,
            "pai": tile,
            "tsumogiri": bool(tsumogiri),
            "riichi": True,
        }
    )
    snapshot["turn"] += 1
    snapshot["currentActor"] = actor
    snapshot["phase"] = "reaction_window"
    persist_snapshot_state(snapshot)
    return True


def apply_discard(snapshot, actor, tile, from_drawn=None):
    sync_snapshot_state(snapshot)
    if tile not in snapshot["hands"][actor]:
        raise ValueError(f"Tile {tile} not found in actor {actor} hand.")
    ippatsu_flags = ensure_ippatsu_flags(snapshot)
    tsumogiri = False
    if from_drawn is not None:
        tsumogiri = bool(from_drawn)
    elif snapshot["actionHistory"]:
        last_action = snapshot["actionHistory"][-1]
        tsumogiri = last_action.get("type") == "tsumo" and last_action.get("actor") == actor and last_action.get("pai") == tile
    if has_pending_riichi(snapshot, actor) and not snapshot["riichiDeclared"][actor]:
        snapshot["riichiDeclared"][actor] = True
        snapshot["actionHistory"].append(
            {
                "type": "reach",
                "actor": actor,
            }
        )
    hand = snapshot["hands"][actor]
    if tsumogiri and hand.count(tile) > 1:
        # Remove the DRAWN copy (last occurrence in sorted hand — draw_tile
        # appends then sorts; Python stable sort keeps it after the old copy)
        last_idx = len(hand) - 1 - hand[::-1].index(tile)
        hand.pop(last_idx)
    else:
        hand.remove(tile)
    promote_delayed_dora_reveal(snapshot)
    if has_pending_riichi(snapshot, actor):
        stage_riichi_discard(snapshot, actor, tile, tsumogiri)
        return

    if snapshot.get("riichiAccepted", [False, False, False, False])[actor] and ippatsu_flags[actor]:
        ippatsu_flags[actor] = False

    next_actor = (actor + 1) % 4
    snapshot["pendingDiscard"] = {
        "actor": actor,
        "pai": tile,
        "tsumogiri": tsumogiri,
        "targetActor": next_actor,
        "riichi": False,
    }
    snapshot["reactionWindow"] = None
    snapshot["lastAction"] = {
        "type": "dahai",
        "actor": actor,
        "pai": tile,
        "tsumogiri": tsumogiri,
        "riichi": False,
    }
    snapshot["actionHistory"].append(
        {
            "type": "dahai",
            "actor": actor,
            "pai": tile,
            "tsumogiri": tsumogiri,
            "riichi": False,
        }
    )
    snapshot["turn"] += 1
    snapshot["currentActor"] = actor
    snapshot["phase"] = "reaction_window"
    persist_snapshot_state(snapshot)


def resolve_discard_tsumogiri(snapshot, actor, tile, requested=None):
    """Normalize engine intent against the actual drawn tile and hand contents."""
    action_history = snapshot.get("actionHistory") or []
    last_action = action_history[-1] if action_history else {}
    is_drawn_tile = (
        last_action.get("type") == "tsumo"
        and last_action.get("actor") == actor
        and str(last_action.get("pai") or "") == str(tile or "")
    )
    if not is_drawn_tile:
        return False

    hand = snapshot.get("hands", [[], [], [], []])[actor]
    if hand.count(tile) <= 1:
        return True
    if isinstance(requested, bool):
        return requested
    return True


def choose_ai_discard(snapshot, actor):
    sync_snapshot_state(snapshot)
    model_path = get_action_engine_weight_path()
    can_use_drawn_tile_options = actor_just_drew(snapshot, actor)
    response = choose_ai_action_for_current_node(snapshot, actor, model_path)
    requested_tsumogiri = response.get("tsumogiri") if isinstance(response.get("tsumogiri"), bool) else None
    used_fallback = False
    debug_flow(f"[FLOW] choose_ai_discard actor={actor} can_use_drawn={can_use_drawn_tile_options} response_type={response.get('type')} pai={response.get('pai')}")
    if (
        can_use_drawn_tile_options
        and response.get("type") == "reach"
        and can_declare_riichi(snapshot, actor)
    ):
        return {"type": "reach", "actor": actor}

    if can_use_drawn_tile_options and response.get("type") in ("ankan", "kakan"):
        debug_flow("[FLOW] choose_ai_discard returning kan action")
        return copy.deepcopy(response)

    if response.get("type") in ("none", "pon", "chi", "daiminkan", "reach", "ankan", "kakan"):
        debug_flow(f"[FLOW] choose_ai_discard FALLBACK from type={response.get('type')}")
        fallback_tile = None
        if snapshot.get("actionHistory"):
            last_action = snapshot["actionHistory"][-1]
            if last_action.get("type") == "tsumo" and last_action.get("actor") == actor:
                candidate = str(last_action.get("pai") or "")
                if candidate in snapshot["hands"][actor]:
                    fallback_tile = candidate
        if fallback_tile is None and snapshot["hands"][actor]:
            fallback_tile = snapshot["hands"][actor][-1]
        if fallback_tile is None:
            raise ValueError(f"AI actor {actor} had no fallback discard after invalid discard-phase response: {response}")
        response = {
            "type": "dahai",
            "actor": actor,
            "pai": fallback_tile,
            "meta": {
                "fallback": True,
                "original": copy.deepcopy(response),
            },
        }
        used_fallback = True

    if can_use_drawn_tile_options and response.get("type") == "hora":
        winning_tile = None
        if snapshot.get("actionHistory"):
            last_action = snapshot["actionHistory"][-1]
            if last_action.get("type") == "tsumo" and last_action.get("actor") == actor:
                winning_tile = str(last_action.get("pai") or "")
        if winning_tile and can_declare_tsumo(snapshot, actor):
            try:
                compute_hora_result(copy.deepcopy(snapshot), actor, actor, winning_tile, True)
                return {
                    "type": "hora",
                    "actor": actor,
                    "pai": winning_tile,
                }
            except Exception:  # pylint: disable=broad-except
                pass
        response = {
            "type": "none",
            "actor": actor,
            "variant": "none",
            "label": "Pass",
            "meta": {
                "skip_reason": "invalid_self_hora",
            },
        }

    if response.get("type") != "dahai":
        fallback_tile = None
        if snapshot.get("actionHistory"):
            last_action = snapshot["actionHistory"][-1]
            if last_action.get("type") == "tsumo" and last_action.get("actor") == actor:
                candidate = str(last_action.get("pai") or "")
                if candidate in snapshot["hands"][actor]:
                    fallback_tile = candidate
        if fallback_tile is None and snapshot["hands"][actor]:
            fallback_tile = snapshot["hands"][actor][-1]
        if fallback_tile is None:
            raise ValueError(f"Unsupported AI response for current discard flow: {response}")
        response = {
            "type": "dahai",
            "actor": actor,
            "pai": fallback_tile,
            "meta": {
                "fallback": True,
                "original": copy.deepcopy(response),
            },
        }
        used_fallback = True
    tile = response.get("pai")
    if tile not in snapshot["hands"][actor]:
        normalized = str(tile).replace("5m", "5mr").replace("5p", "5pr").replace("5s", "5sr")
        if normalized in snapshot["hands"][actor]:
            tile = normalized
    if tile not in snapshot["hands"][actor]:
        fallback_tile = None
        if snapshot.get("actionHistory"):
            last_action = snapshot["actionHistory"][-1]
            if last_action.get("type") == "tsumo" and last_action.get("actor") == actor:
                candidate = str(last_action.get("pai") or "")
                if candidate in snapshot["hands"][actor]:
                    fallback_tile = candidate
        if fallback_tile is None and snapshot["hands"][actor]:
            fallback_tile = snapshot["hands"][actor][-1]
        if fallback_tile is None:
            raise ValueError(f"AI selected tile {tile} not present in hand for actor {actor}.")
        tile = fallback_tile
        used_fallback = True
    return {
        "type": "dahai",
        "actor": actor,
        "pai": tile,
        "tsumogiri": resolve_discard_tsumogiri(
            snapshot,
            actor,
            tile,
            None if used_fallback else requested_tsumogiri,
        ),
    }


def get_reaction_priority(action_type):
    priorities = {
        "none": 0,
        "chi": 1,
        "pon": 2,
        "daiminkan": 3,
        "hora": 4,
    }
    return priorities.get(action_type, -1)


def can_resolve_hora_reaction(snapshot, winner, target, win_tile):
    del target, win_tile
    try:
        return bool(can_declare_ron(snapshot, int(winner)))
    except Exception:  # pylint: disable=broad-except
        return False


def normalize_called_tile(snapshot, actor, tile):
    if tile in snapshot["hands"][actor]:
        return tile

    normalized_candidates = {
        "5m": ["5m", "5mr"],
        "5p": ["5p", "5pr"],
        "5s": ["5s", "5sr"],
    }.get(tile, [tile])

    for candidate in normalized_candidates:
        if candidate in snapshot["hands"][actor]:
            return candidate

    return tile


def remove_consumed_tiles(snapshot, actor, consumed):
    sync_snapshot_state(snapshot)
    for tile in consumed:
        actual_tile = normalize_called_tile(snapshot, actor, tile)
        if actual_tile not in snapshot["hands"][actor]:
            raise ValueError(f"Consumed tile {tile} not found in actor {actor} hand.")
        snapshot["hands"][actor].remove(actual_tile)
    persist_snapshot_state(snapshot)


def remove_single_tile(snapshot, actor, tile):
    sync_snapshot_state(snapshot)
    actual_tile = normalize_called_tile(snapshot, actor, tile)
    if actual_tile not in snapshot["hands"][actor]:
        raise ValueError(f"Tile {tile} not found in actor {actor} hand.")
    snapshot["hands"][actor].remove(actual_tile)
    persist_snapshot_state(snapshot)
    return actual_tile


def apply_self_kan_action(snapshot, response):
    sync_snapshot_state(snapshot)
    actor = int(response["actor"])
    action_type = str(response.get("type") or "")
    # The riichi ankan prompt is a one-shot state. Carrying it into the
    # rinshan draw would expose a second, invalid skip prompt.
    snapshot["riichiDiscardState"] = None
    clear_all_ippatsu(snapshot)
    promote_delayed_dora_reveal(snapshot)
    persist_snapshot_state(snapshot)
    if action_type == "ankan":
        consumed = response.get("consumed", [])
        remove_consumed_tiles(snapshot, actor, consumed)
        snapshot["melds"][actor].append(copy.deepcopy(response))
    elif action_type == "kakan":
        start_kakan_reaction_window(snapshot, response)
        return
    elif action_type == "daiminkan":
        consumed = response.get("consumed", [])
        remove_consumed_tiles(snapshot, actor, consumed)
        snapshot["melds"][actor].append(copy.deepcopy(response))
    else:
        raise ValueError(f"Unsupported kan action: {action_type}")

    snapshot["lastAction"] = copy.deepcopy(response)
    snapshot["actionHistory"].append(copy.deepcopy(response))
    persist_snapshot_state(snapshot)
    if action_type == "ankan":
        queue_dora_reveal(snapshot, after_action=False)
    else:
        queue_dora_reveal(snapshot, after_action=True)
    snapshot["currentActor"] = actor
    snapshot["pendingRinshanDraw"] = True
    snapshot["phase"] = "draw_or_discard"
    persist_snapshot_state(snapshot)


def build_kan_reaction_window(snapshot):
    sync_snapshot_state(snapshot)
    pending_kan = snapshot.get("pendingKan")
    if not pending_kan:
        return None

    actor = int(pending_kan["actor"])
    seats_in_order = [((actor + offset) % 4) for offset in range(1, 4)]
    reactions = []
    reaction_thinking_time_s = 0.0

    for seat in seats_in_order:
        model_path = get_action_engine_weight_path()
        try:
            response = choose_ai_action_for_snapshot(snapshot, seat, model_path, accumulate_thinking=False)
        except Exception as error:  # pylint: disable=broad-except
            response = {
                "type": "none",
                "actor": seat,
                "variant": "none",
                "label": "Pass",
                "meta": {
                    "skip_reason": "kan_reaction_error",
                    "error": str(error),
                },
            }
        reaction_thinking_time_s = max(
            reaction_thinking_time_s,
            float(((response.get("meta") or {}).get("thinking_time_s") or 0.0)),
        )
        reaction_type = response.get("type", "none")
        if reaction_type == "hora":
            if not can_resolve_hora_reaction(snapshot, seat, actor, pending_kan.get("pai")):
                response = {"type": "none", "actor": seat, "variant": "none", "label": "Pass"}
                reaction_type = "none"
        else:
            response = {"type": "none", "actor": seat, "variant": "none", "label": "Pass"}
            reaction_type = "none"
        reactions.append(
            {
                "seat": seat,
                "response": response,
                "priority": get_reaction_priority(reaction_type),
            }
        )

    selected = max(reactions, key=lambda item: (item["priority"], -seats_in_order.index(item["seat"])))
    return {
        "kan": copy.deepcopy(pending_kan),
        "reactions": reactions,
        "selected": copy.deepcopy(selected),
        "thinkingTimeS": reaction_thinking_time_s,
    }


def start_kakan_reaction_window(snapshot, response):
    sync_snapshot_state(snapshot)
    actor = int(response["actor"])
    pai = str(response.get("pai") or "")
    remove_single_tile(snapshot, actor, pai)
    consumed = None
    for meld in snapshot["melds"][actor]:
        if meld.get("type") == "pon" and str(meld.get("pai") or "") == pai:
            consumed = [str(tile) for tile in copy.deepcopy(meld.get("consumed") or [])]
            while len(consumed) < 3:
                consumed.append(pai)
            break
    if not consumed:
        consumed = [pai, pai, pai]
    response = copy.deepcopy(response)
    response["consumed"] = consumed
    pending_kan = copy.deepcopy(response)
    pending_kan["source"] = "kakan"
    snapshot["pendingKan"] = pending_kan
    snapshot["pendingDiscard"] = None
    snapshot["reactionWindow"] = None
    snapshot["lastAction"] = copy.deepcopy(response)
    snapshot["actionHistory"].append(copy.deepcopy(response))
    snapshot["currentActor"] = actor
    snapshot["phase"] = "kan_reaction_window"
    persist_snapshot_state(snapshot)
    snapshot["kanReactionWindow"] = build_kan_reaction_window(snapshot)
    persist_snapshot_state(snapshot)


def finalize_kakan_resolution(snapshot):
    sync_snapshot_state(snapshot)
    pending_kan = copy.deepcopy(snapshot.get("pendingKan"))
    if not pending_kan:
        return

    actor = int(pending_kan["actor"])
    pai = str(pending_kan.get("pai") or "")
    upgraded = False
    for meld in snapshot["melds"][actor]:
        if meld.get("type") == "pon" and str(meld.get("pai") or "") == pai:
            meld["type"] = "kakan"
            meld["kakan"] = pai
            meld["consumed"] = copy.deepcopy(pending_kan.get("consumed") or [pai, pai, pai])
            upgraded = True
            break
    if not upgraded:
        snapshot["melds"][actor].append(copy.deepcopy(pending_kan))

    snapshot["pendingKan"] = None
    snapshot["kanReactionWindow"] = None
    persist_snapshot_state(snapshot)
    queue_dora_reveal(snapshot, after_action=True)
    snapshot["pendingRinshanDraw"] = True
    snapshot["currentActor"] = actor
    snapshot["phase"] = "draw_or_discard"
    persist_snapshot_state(snapshot)


def evaluate_reactions(snapshot):
    sync_snapshot_state(snapshot)
    pending_discard = snapshot.get("pendingDiscard")
    if not pending_discard:
        return None

    discard_actor = pending_discard["actor"]
    seats_in_order = [((discard_actor + offset) % 4) for offset in range(1, 4)]
    reactions = []
    reaction_thinking_time_s = 0.0

    for seat in seats_in_order:
        if seat == STATE["controlledSeat"]:
            response = {"type": "none", "actor": seat, "variant": "none", "label": "Pass"}
        else:
            model_path = get_action_engine_weight_path()
            try:
                response = choose_ai_action_for_snapshot(snapshot, seat, model_path, accumulate_thinking=False)
            except Exception as error:  # pylint: disable=broad-except
                response = {
                    "type": "none",
                    "actor": seat,
                    "variant": "none",
                    "label": "Pass",
                    "meta": {
                        "skip_reason": "reaction_error",
                        "error": str(error),
                    },
                }
        reaction_thinking_time_s = max(
            reaction_thinking_time_s,
            float(((response.get("meta") or {}).get("thinking_time_s") or 0.0)),
        )
        reaction_type = response.get("type", "none")
        if seat != pending_discard["targetActor"] and reaction_type == "chi":
            response = {"type": "none", "actor": seat, "meta": {"skip_reason": "non_adjacent_chi"}}
            reaction_type = "none"
        elif reaction_type == "hora":
            if not can_resolve_hora_reaction(snapshot, seat, discard_actor, pending_discard["pai"]):
                response = {
                    "type": "none",
                    "actor": seat,
                    "variant": "none",
                    "label": "Pass",
                    "meta": {
                        "skip_reason": "invalid_hora_reaction",
                        "original": copy.deepcopy(response),
                    },
                }
                reaction_type = "none"
        elif (
            reaction_type in ("chi", "pon", "daiminkan")
            and snapshot.get("riichiAccepted", [False, False, False, False])[seat]
        ):
            response = {
                "type": "none",
                "actor": seat,
                "variant": "none",
                "label": "Pass",
                "meta": {
                    "skip_reason": "riichi_blocked",
                    "original": copy.deepcopy(response),
                },
            }
            reaction_type = "none"
        elif reaction_type in ("chi", "pon", "daiminkan"):
            resolved_consumed = resolve_reaction_hand_consumed(
                snapshot["hands"][seat],
                response,
                pending_discard["pai"],
                normalize_tile_family,
            )
            expected_count = get_reaction_expected_hand_count(reaction_type) or 0
            if len(resolved_consumed) != expected_count:
                response = {
                    "type": "none",
                    "actor": seat,
                    "variant": "none",
                    "label": "Pass",
                    "meta": {
                        "skip_reason": "invalid_reaction_consumed",
                        "original": copy.deepcopy(response),
                    },
                }
                reaction_type = "none"
            else:
                response = copy.deepcopy(response)
                response["consumed"] = copy.deepcopy(resolved_consumed)
        reactions.append(
            {
                "seat": seat,
                "response": response,
                "priority": get_reaction_priority(reaction_type),
            }
        )

    selected = max(reactions, key=lambda item: (item["priority"], -seats_in_order.index(item["seat"])))

    return {
        "discard": copy.deepcopy(pending_discard),
        "reactions": reactions,
        "selected": copy.deepcopy(selected),
        "thinkingTimeS": reaction_thinking_time_s,
    }


def finalize_pending_discard_to_river(snapshot):
    sync_snapshot_state(snapshot)
    pending_discard = snapshot.get("pendingDiscard")
    if not pending_discard:
        return
    snapshot["rivers"][pending_discard["actor"]].append(pending_discard["pai"])
    snapshot["pendingDiscard"] = None
    persist_snapshot_state(snapshot)


def apply_reaction_action(snapshot, selected):
    sync_snapshot_state(snapshot)
    response = selected["response"]
    action_type = response.get("type")
    if snapshot.get("phase") == "kan_reaction_window":
        pending_kan = copy.deepcopy(snapshot.get("pendingKan") or {})
        if action_type == "none":
            finalize_kakan_resolution(snapshot)
            return

        if action_type == "hora":
            winner = int(response.get("actor", snapshot.get("currentActor", 0)))
            target = int(pending_kan.get("actor", snapshot.get("currentActor", 0)))
            win_tile = str(pending_kan.get("pai") or "")
            result = compute_hora_result(snapshot, winner, target, win_tile, False)
            snapshot["kanReactionWindow"] = None
            snapshot["pendingKan"] = None
            snapshot["pendingDiscard"] = None
            snapshot["reactionWindow"] = None
            snapshot["lastAction"] = {
                "type": "hora",
                "actor": winner,
                "target": target,
                "pai": win_tile,
                "isTsumo": False,
                "deltas": copy.deepcopy(result["deltas"]),
                "uraMarkers": copy.deepcopy(result["uraMarkers"]),
                "han": result.get("han"),
                "fu": result.get("fu"),
                "yaku": copy.deepcopy(result.get("yaku", [])),
                "yakuDetails": copy.deepcopy(result.get("yakuDetails", [])),
                "isOpenHand": result.get("isOpenHand"),
                "cost": copy.deepcopy(result.get("cost", {})),
            }
            snapshot["actionHistory"].append(copy.deepcopy(response))
            snapshot["phase"] = "game_end"
            snapshot["currentActor"] = winner
            persist_snapshot_state(snapshot)
            return

        raise ValueError(f"Unsupported kan reaction action: {response}")

    discard = snapshot["pendingDiscard"]
    had_pending_riichi = snapshot.get("pendingRiichiSeat") is not None

    if action_type == "none":
        finalize_pending_discard_to_river(snapshot)
        snapshot["reactionWindow"] = None
        # Riichi is accepted before the next draw.
        if had_pending_riichi:
            resolve_pending_riichi_acceptance(snapshot)
        if maybe_mark_abortive_ryukyoku(snapshot):
            return
        snapshot["currentActor"] = discard["targetActor"]
        snapshot["phase"] = "draw_or_discard"
        persist_snapshot_state(snapshot)
        return

    finalize_pending_discard_to_river(snapshot)
    snapshot["reactionWindow"] = None

    if action_type == "hora":
        winner = int(response.get("actor", discard["targetActor"]))
        target = int(response.get("target", discard["targetActor"]))
        result = compute_hora_result(snapshot, winner, target, str(discard["pai"]), False)
        snapshot["lastAction"] = {
            "type": "hora",
            "actor": winner,
            "target": target,
            "pai": str(discard["pai"]),
            "isTsumo": False,
            "deltas": copy.deepcopy(result["deltas"]),
            "uraMarkers": copy.deepcopy(result["uraMarkers"]),
            "han": result.get("han"),
            "fu": result.get("fu"),
            "yaku": copy.deepcopy(result.get("yaku", [])),
            "yakuDetails": copy.deepcopy(result.get("yakuDetails", [])),
            "isOpenHand": result.get("isOpenHand"),
            "cost": copy.deepcopy(result.get("cost", {})),
        }
        snapshot["actionHistory"].append(copy.deepcopy(response))
        snapshot["phase"] = "game_end"
        snapshot["currentActor"] = response.get("actor", discard["targetActor"])
        persist_snapshot_state(snapshot)
        return

    # Riichi is accepted before processing the following meld.
    if had_pending_riichi:
        resolve_pending_riichi_acceptance(snapshot)

    if action_type in ("pon", "chi"):
        actor = int(response.get("actor", -1))
        if actor >= 0 and snapshot.get("riichiAccepted", [False, False, False, False])[actor]:
            raise ValueError(f"Riichi player cannot {action_type}.")
        clear_all_ippatsu(snapshot)
        actor = response["actor"]
        consumed = get_reaction_hand_consumed(response, discard["pai"], normalize_tile_family)
        resolved_consumed = resolve_reaction_hand_consumed(snapshot["hands"][actor], response, discard["pai"], normalize_tile_family)
        remove_consumed_tiles(snapshot, actor, resolved_consumed)
        response = copy.deepcopy(response)
        response["consumed"] = copy.deepcopy(resolved_consumed)
        response["from"] = int(discard["actor"])
        snapshot["melds"][actor].append(copy.deepcopy(response))
        snapshot["lastAction"] = copy.deepcopy(response)
        snapshot["actionHistory"].append(copy.deepcopy(response))
        snapshot["currentActor"] = actor
        snapshot["phase"] = "discard"
        persist_snapshot_state(snapshot)
        return

    if action_type == "daiminkan":
        actor = int(response.get("actor", -1))
        if actor >= 0 and snapshot.get("riichiAccepted", [False, False, False, False])[actor]:
            raise ValueError(f"Riichi player cannot daiminkan.")
        clear_all_ippatsu(snapshot)
        response = copy.deepcopy(response)
        response["consumed"] = copy.deepcopy(
            resolve_reaction_hand_consumed(snapshot["hands"][int(response["actor"])], response, discard["pai"], normalize_tile_family)
        )
        response["from"] = int(discard["actor"])
        apply_self_kan_action(snapshot, response)
        return

    raise ValueError(f"Unsupported reaction action: {response}")


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
            return {"seat": STATE["controlledSeat"], "response": response, "priority": get_reaction_priority(response_type)}

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
        "priority": get_reaction_priority(action_type),
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
        materialize_reach_declaration_discard(next_snapshot, actor, tile, tsumogiri)
        persist_snapshot_state(next_snapshot)
        next_snapshot["reactionWindow"] = (
            None
            if STATE.get("mode") == "play"
            else evaluate_reactions(next_snapshot)
        )
        action = build_review_action_payload("dahai", pai=tile, source=source)
        action["riichi"] = True
        action["tsumogiri"] = bool(from_drawn)
        return next_snapshot, action

    apply_discard(next_snapshot, actor, tile, from_drawn=from_drawn)
    next_snapshot["reactionWindow"] = (
        None
        if STATE.get("mode") == "play"
        else evaluate_reactions(next_snapshot)
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
        if not can_declare_kyuushu_kyuuhai(parent_snapshot, actor):
            raise ValueError("This hand cannot declare 9 terminals abortive draw.")
        mark_abortive_ryukyoku(next_snapshot, variant)
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

        promote_delayed_dora_reveal(next_snapshot)
        reveal_all_pending_dora(next_snapshot)
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
        apply_self_kan_action(next_snapshot, response)
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
    apply_reaction_action(next_snapshot, selected)
    action = copy.deepcopy(selected["response"])
    action["source"] = "user_reaction"
    if action.get("type") == "none":
        action["decisionOnly"] = True
    return next_snapshot, selected, action


def _create_tsumo_node(game, parent_snapshot, actor, source="wall"):
    """Create a TSUMO child node: draw a tile for the actor, transitioning to discard phase."""
    next_snapshot = copy.deepcopy(parent_snapshot)
    drawn_tile = draw_tile(next_snapshot, actor, source=source)
    next_snapshot["pendingRinshanDraw"] = False
    next_snapshot["phase"] = "discard"
    persist_snapshot_state(next_snapshot)
    action = {
        "type": "tsumo",
        "actor": actor,
        "pai": drawn_tile,
    }
    if source != "wall":
        action["source"] = source
    parent_id = game["currentNodeId"]
    child_id = create_node(game, parent_id, action, next_snapshot)
    attach_mainline(parent_id, child_id)
    game["currentNodeId"] = child_id
    promote_path_to_mainline(game, child_id)


def _advance_reaction_window(game, snapshot):
    """Resolve reaction window by creating child nodes for the resolved action.

    The parent (DAHAI) node's snapshot is NOT mutated. Child nodes capture
    the post-reaction state.

    Riichi acceptance (reach_accepted) is handled inside apply_reaction_action
    Rule timing: before the next draw (none) or before the meld.
    (pon/chi/daiminkan). Hora (ron) does NOT accept riichi.
    """
    apply_pending_seat_switch_if_ready(snapshot)
    reaction_window = snapshot.get("reactionWindow")
    if not isinstance(reaction_window, dict) or not isinstance(
        reaction_window.get("selected"), dict
    ):
        snapshot["reactionWindow"] = evaluate_reactions(snapshot)
    if controlled_seat_has_pending_action(snapshot):
        return

    selected = snapshot["reactionWindow"]["selected"]
    resolution_snapshot = _materialize_automatic_reaction_decisions(game, snapshot, selected)
    next_snapshot = copy.deepcopy(resolution_snapshot)
    selected = next_snapshot["reactionWindow"]["selected"]
    response = selected["response"]
    action_type = response.get("type", "none")

    # apply_reaction_action now handles resolve_pending_riichi_acceptance internally
    apply_reaction_action(next_snapshot, selected)

    if next_snapshot["phase"] == "game_end":
        last = next_snapshot.get("lastAction") or {}
        if last.get("type") == "ryukyoku":
            action = {
                "type": "ryukyoku",
                "actor": last.get("actor", selected["seat"]),
                "reason": last.get("reason"),
                "reasonLabel": last.get("reasonLabel"),
            }
        else:
            # Hora (ron) – riichi is NOT accepted when the declaration tile is
            # ron'd, so no reach_accepted node is created and no bet is collected.
            action = {
                "type": "hora",
                "actor": last.get("actor", selected["seat"]),
                "target": last.get("target"),
                "pai": last.get("pai"),
            }
        parent_id = game["currentNodeId"]
        child_id = create_node(game, parent_id, action, next_snapshot)
        attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        promote_path_to_mainline(game, child_id)
        return

    if action_type == "none":
        actor = next_snapshot["currentActor"]
        if len(next_snapshot["hands"][actor]) % 3 != 2:
            if not has_wall_draw_available(next_snapshot):
                mark_exhaustive_ryukyoku(next_snapshot)
                last = next_snapshot.get("lastAction") or {}
                action = {
                    "type": "ryukyoku",
                    "actor": next_snapshot.get("dealer", 0),
                    "reason": last.get("reason"),
                    "reasonLabel": last.get("reasonLabel"),
                }
                parent_id = game["currentNodeId"]
                child_id = create_node(game, parent_id, action, next_snapshot)
                attach_mainline(parent_id, child_id)
                game["currentNodeId"] = child_id
                promote_path_to_mainline(game, child_id)
                advance_terminal_round(game)
                return
            draw_one(next_snapshot, actor)
        action = {
            "type": "tsumo",
            "actor": actor,
            "pai": next_snapshot["hands"][actor][-1] if next_snapshot["hands"][actor] else "",
        }
    else:
        # pon, chi, daiminkan
        action = copy.deepcopy(response)
        parent_id = game["currentNodeId"]
        child_id = create_node(game, parent_id, action, next_snapshot)
        attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        promote_path_to_mainline(game, child_id)
        return

    parent_id = game["currentNodeId"]
    child_id = create_node(game, parent_id, action, next_snapshot)
    attach_mainline(parent_id, child_id)
    game["currentNodeId"] = child_id
    promote_path_to_mainline(game, child_id)


def _advance_kan_reaction_window(game, snapshot):
    """Resolve kan reaction window by creating a child node."""
    apply_pending_seat_switch_if_ready(snapshot)
    reaction_window = snapshot.get("kanReactionWindow")
    if not isinstance(reaction_window, dict) or not isinstance(
        reaction_window.get("selected"), dict
    ):
        snapshot["kanReactionWindow"] = build_kan_reaction_window(snapshot)
    if controlled_seat_has_pending_action(snapshot):
        return

    selected = snapshot["kanReactionWindow"]["selected"]
    resolution_snapshot = _materialize_automatic_reaction_decisions(game, snapshot, selected)
    next_snapshot = copy.deepcopy(resolution_snapshot)
    selected = next_snapshot["kanReactionWindow"]["selected"]
    response = selected["response"]
    action_type = response.get("type", "none")

    apply_reaction_action(next_snapshot, selected)

    if next_snapshot["phase"] == "game_end":
        last = next_snapshot.get("lastAction") or {}
        if last.get("type") == "ryukyoku":
            action = {
                "type": "ryukyoku",
                "actor": last.get("actor", selected["seat"]),
                "reason": last.get("reason"),
                "reasonLabel": last.get("reasonLabel"),
            }
        else:
            action = {
                "type": "hora",
                "actor": last.get("actor", selected["seat"]),
                "target": last.get("target"),
                "pai": last.get("pai"),
            }
        parent_id = game["currentNodeId"]
        child_id = create_node(game, parent_id, action, next_snapshot)
        attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        promote_path_to_mainline(game, child_id)
        return

    if action_type == "none":
        actor = next_snapshot["currentActor"]
        draw_tile(next_snapshot, actor, source="rinshan")
        next_snapshot["pendingRinshanDraw"] = False
        next_snapshot["phase"] = "discard"
        persist_snapshot_state(next_snapshot)
        action = {
            "type": "tsumo",
            "actor": actor,
            "pai": next_snapshot["hands"][actor][-1],
            "source": "rinshan",
        }
    else:
        action = copy.deepcopy(response)

    parent_id = game["currentNodeId"]
    child_id = create_node(game, parent_id, action, next_snapshot)
    attach_mainline(parent_id, child_id)
    game["currentNodeId"] = child_id
    promote_path_to_mainline(game, child_id)


def _process_ai_discard(game, snapshot, actor):
    """Compute AI discard action and create the appropriate child node."""
    debug_flow(f"[FLOW] _process_ai_discard actor={actor} phase={snapshot.get('phase')} hand_len={len(snapshot['hands'][actor])}")
    ai_action = choose_ai_discard(snapshot, actor)
    debug_flow(f"[FLOW] _process_ai_discard ai_action type={ai_action.get('type')} pai={ai_action.get('pai')} riichi={ai_action.get('riichi')}")

    if ai_action["type"] == "hora":
        next_snapshot = copy.deepcopy(snapshot)
        if ai_action.get("riichi"):
            next_snapshot["pendingRiichiSeat"] = actor
            if "kyokuState" in next_snapshot:
                next_snapshot["kyokuState"]["pendingRiichiSeat"] = actor
            next_snapshot["riichiDeclared"][actor] = True
            next_snapshot["actionHistory"].append({"type": "reach", "actor": actor})
            accept_riichi_for_seat(next_snapshot, actor, clear_pending=True)
        promote_delayed_dora_reveal(next_snapshot)
        reveal_all_pending_dora(next_snapshot)
        result = compute_hora_result(next_snapshot, actor, actor, str(ai_action.get("pai") or ""), True)
        next_snapshot["pendingDiscard"] = None
        next_snapshot["reactionWindow"] = None
        next_snapshot["phase"] = "game_end"
        next_snapshot["currentActor"] = actor
        next_snapshot["lastAction"] = {
            "type": "hora",
            "actor": actor,
            "target": actor,
            "pai": str(ai_action.get("pai") or ""),
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
        next_snapshot["actionHistory"].append({
            "type": "hora",
            "actor": actor,
            "target": actor,
            "pai": str(ai_action.get("pai") or ""),
        })
        persist_snapshot_state(next_snapshot)
        action = {
            "type": "hora",
            "actor": actor,
            "target": actor,
            "pai": str(ai_action.get("pai") or ""),
            "variant": "tsumo",
            "source": "ai",
        }
        if ai_action.get("riichi"):
            action["riichi"] = True
        parent_id = game["currentNodeId"]
        child_id = create_node(game, parent_id, action, next_snapshot)
        attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        promote_path_to_mainline(game, child_id)
        return

    if ai_action["type"] in ("ankan", "kakan"):
        next_snapshot = copy.deepcopy(snapshot)
        apply_self_kan_action(next_snapshot, ai_action)
        action = copy.deepcopy(ai_action)
        action["source"] = "ai"
        parent_id = game["currentNodeId"]
        child_id = create_node(game, parent_id, action, next_snapshot)
        attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        promote_path_to_mainline(game, child_id)
        if next_snapshot["phase"] != "game_end":
            return
        advance_terminal_round(game)
        return

    if ai_action["type"] == "reach":
        next_snapshot = copy.deepcopy(snapshot)
        sync_snapshot_state(next_snapshot)
        next_snapshot["pendingRiichiSeat"] = actor
        if "kyokuState" in next_snapshot:
            next_snapshot["kyokuState"]["pendingRiichiSeat"] = actor
        next_snapshot["riichiDeclared"][actor] = True
        next_snapshot["actionHistory"].append({"type": "reach", "actor": actor})
        next_snapshot["lastAction"] = {"type": "reach", "actor": actor}
        next_snapshot["phase"] = "reach_declaration"
        next_snapshot["pendingDiscard"] = None
        next_snapshot["reactionWindow"] = None
        persist_snapshot_state(next_snapshot)
        action = {
            "type": "reach",
            "actor": actor,
            "source": "ai",
        }
        parent_id = game["currentNodeId"]
        child_id = create_node(game, parent_id, action, next_snapshot)
        attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        promote_path_to_mainline(game, child_id)
        return

    if snapshot.get("riichiDiscardState") == "ankan_choice":
        skip_action = next(
            (
                copy.deepcopy(candidate)
                for candidate in build_legal_actions(snapshot, controlled_seat=actor)
                if candidate.get("type") == "none"
            ),
            None,
        )
        if skip_action is not None:
            skip_action.pop("id", None)
            skip_action["decisionOnly"] = True
            skip_action["source"] = "ai"
            skip_snapshot = copy.deepcopy(snapshot)
            skip_snapshot["riichiDiscardState"] = None
            persist_snapshot_state(skip_snapshot)
            parent_id = game["currentNodeId"]
            skip_id = create_node(game, parent_id, skip_action, skip_snapshot)
            attach_mainline(parent_id, skip_id)
            game["currentNodeId"] = skip_id
            promote_path_to_mainline(game, skip_id)
            snapshot = skip_snapshot

    discard_tile = ai_action["pai"]
    tsumogiri = bool(ai_action.get("tsumogiri"))
    next_snapshot = copy.deepcopy(snapshot)
    apply_discard(next_snapshot, actor, discard_tile, from_drawn=tsumogiri)
    next_snapshot["reactionWindow"] = None
    action = {
        "type": "dahai",
        "actor": actor,
        "pai": discard_tile,
        "tsumogiri": tsumogiri,
        "source": "ai",
    }
    parent_id = game["currentNodeId"]
    child_id = create_node(game, parent_id, action, next_snapshot)
    attach_mainline(parent_id, child_id)
    game["currentNodeId"] = child_id
    promote_path_to_mainline(game, child_id)


def _process_riichi_auto_tsumogiri(game, snapshot, actor):
    """Auto-discard the drawn tile as tsumogiri for a riichi'd player."""
    hand = list(snapshot.get("hands", [])[actor])
    action_history = snapshot.get("actionHistory") or []
    last_action = action_history[-1] if action_history else {}
    drawn_tile = last_action.get("pai", "") if last_action.get("type") == "tsumo" and last_action.get("actor") == actor else ""
    if not drawn_tile and hand:
        drawn_tile = hand[-1]
    if not drawn_tile:
        raise ValueError("Cannot determine drawn tile for riichi auto-tsumogiri.")

    next_snapshot = copy.deepcopy(snapshot)
    next_snapshot["riichiDiscardState"] = None
    apply_discard(next_snapshot, actor, drawn_tile)
    next_snapshot["reactionWindow"] = None

    action = {
        "type": "dahai",
        "actor": actor,
        "pai": drawn_tile,
        "tsumogiri": True,
        "source": "riichi_auto",
    }

    parent_id = game["currentNodeId"]
    child_id = create_node(game, parent_id, action, next_snapshot)
    attach_mainline(parent_id, child_id)
    game["currentNodeId"] = child_id
    promote_path_to_mainline(game, child_id)


def advance_game_flow(game):
    """Process exactly one mjai action per call, creating a tree node for each frame."""
    current_snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]

    if current_snapshot["phase"] == "match_end":
        return

    if current_snapshot["phase"] == "game_end":
        advance_terminal_round(game)
        return

    if current_snapshot["phase"] == "round_result":
        match_state = game.get("matchState") or {}
        last_result = (current_snapshot.get("lastAction") or {}).get("result") or {}
        round_result_stub = {
            "canRenchan": bool(last_result.get("canRenchan", False)),
            "hasHora": bool(last_result.get("hasHora", False)),
            "hasAbortiveRyukyoku": bool(last_result.get("hasAbortiveRyukyoku", False)),
            "eventType": last_result.get("eventType"),
            "eventData": copy.deepcopy(last_result.get("eventData") or {}),
            "scores": copy.deepcopy(last_result.get(
                "scores",
                current_snapshot.get("scores", [25000, 25000, 25000, 25000]),
            )),
            "kyotakuLeft": int(last_result.get("kyotakuLeft", current_snapshot.get("kyotaku", 0))),
        }
        if match_state.get("ended"):
            game["currentNodeId"] = ensure_match_end_node(
                game,
                game["currentNodeId"],
                current_snapshot,
                round_result_stub,
                match_state,
            )
        else:
            next_kyoku_snapshot = create_next_kyoku_snapshot(current_snapshot, match_state)
            commit_system_transition(
                game,
                game["currentNodeId"],
                {
                    "type": "start_kyoku",
                    "source": "system",
                    "bakaze": match_state.get("bakaze", "E"),
                    "kyoku": match_state.get("kyoku", 1),
                },
                next_kyoku_snapshot,
            )
        return

    if current_snapshot["phase"] == "reach_declaration":
        if current_snapshot["currentActor"] == STATE["controlledSeat"]:
            return
        actor = current_snapshot["currentActor"]
        model_path = get_action_engine_weight_path()
        response = choose_ai_action_for_current_node(current_snapshot, actor, model_path)
        debug_flow(f"[FLOW] advance reach_declaration AI actor={actor} response_type={response.get('type')} pai={response.get('pai')}")

        tile = response.get("pai") if response.get("type") == "dahai" else None
        used_fallback = response.get("type") != "dahai"
        requested_tsumogiri = response.get("tsumogiri") if isinstance(response.get("tsumogiri"), bool) else None
        if not tile or tile not in current_snapshot["hands"][actor]:
            normalized = str(tile or "").replace("5m", "5mr").replace("5p", "5pr").replace("5s", "5sr")
            if normalized in current_snapshot["hands"][actor]:
                tile = normalized
        if not tile or tile not in current_snapshot["hands"][actor]:
            if current_snapshot.get("actionHistory"):
                last_action = current_snapshot["actionHistory"][-1]
                if last_action.get("type") == "tsumo" and last_action.get("actor") == actor:
                    candidate = str(last_action.get("pai") or "")
                    if candidate in current_snapshot["hands"][actor]:
                        tile = candidate
                        used_fallback = True
        if not tile or tile not in current_snapshot["hands"][actor]:
            tile = current_snapshot["hands"][actor][-1] if current_snapshot["hands"][actor] else None
            used_fallback = True
        if not tile:
            raise ValueError(f"AI reach_declaration: no valid discard tile for actor {actor}")

        tsumogiri = resolve_discard_tsumogiri(
            current_snapshot,
            actor,
            tile,
            None if used_fallback else requested_tsumogiri,
        )

        next_snapshot = copy.deepcopy(current_snapshot)
        sync_snapshot_state(next_snapshot)
        materialize_reach_declaration_discard(next_snapshot, actor, tile, tsumogiri)
        persist_snapshot_state(next_snapshot)
        next_snapshot["reactionWindow"] = None
        action = {
            "type": "dahai",
            "actor": actor,
            "pai": tile,
            "tsumogiri": tsumogiri,
            "riichi": True,
            "source": "ai",
        }
        parent_id = game["currentNodeId"]
        child_id = create_node(game, parent_id, action, next_snapshot)
        attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        promote_path_to_mainline(game, child_id)
        return

    if has_immediate_dora_reveal(current_snapshot):
        next_snapshot = copy.deepcopy(current_snapshot)
        consume_immediate_dora_reveal(next_snapshot)
        reveal_next_dora(next_snapshot)
        maybe_mark_abortive_ryukyoku(next_snapshot)
        persist_snapshot_state(next_snapshot)
        action = copy.deepcopy(next_snapshot.get("lastAction") or {"type": "dora", "actor": current_snapshot.get("currentActor", 0)})
        parent_id = game["currentNodeId"]
        child_id = create_node(game, parent_id, action, next_snapshot)
        attach_mainline(parent_id, child_id)
        game["currentNodeId"] = child_id
        promote_path_to_mainline(game, child_id)
        return

    if current_snapshot.get("pendingRinshanDraw") and current_snapshot["phase"] == "draw_or_discard":
        actor = current_snapshot["currentActor"]
        _create_tsumo_node(game, current_snapshot, actor, source="rinshan")
        return

    if current_snapshot["phase"] == "reaction_window":
        _advance_reaction_window(game, current_snapshot)
        return

    if current_snapshot["phase"] == "kan_reaction_window":
        _advance_kan_reaction_window(game, current_snapshot)
        return

    apply_pending_seat_switch_if_ready(current_snapshot)
    actor = current_snapshot["currentActor"]

    if current_snapshot["phase"] == "draw_or_discard":
        if len(current_snapshot["hands"][actor]) % 3 == 2:
            current_snapshot["phase"] = "discard"
        else:
            if not has_wall_draw_available(current_snapshot):
                mark_exhaustive_ryukyoku(current_snapshot)
                advance_terminal_round(game)
                return
            _create_tsumo_node(game, current_snapshot, actor)
            return

    if actor == STATE["controlledSeat"] and current_snapshot["phase"] == "discard":
        if current_snapshot.get("riichiAccepted", [False, False, False, False])[actor]:
            if actor_just_drew(current_snapshot, actor) and can_declare_tsumo(current_snapshot, actor):
                debug_flow(f"[FLOW] advance_game_flow WAIT_USER riichi tsumo available actor={actor}")
                return

            riichi_state = current_snapshot.get("riichiDiscardState")
            if riichi_state == "ankan_choice":
                current_snapshot["riichiDiscardState"] = None
                _process_riichi_auto_tsumogiri(game, current_snapshot, actor)
                return
            if riichi_state != "pending_pause":
                current_snapshot["riichiDiscardState"] = "pending_pause"
                return
            if can_ankan(current_snapshot, actor):
                current_snapshot["riichiDiscardState"] = "ankan_choice"
                return
            current_snapshot["riichiDiscardState"] = None
            _process_riichi_auto_tsumogiri(game, current_snapshot, actor)
            return

        debug_flow(f"[FLOW] advance_game_flow WAIT_USER phase={current_snapshot['phase']} actor={actor}")
        return

    if current_snapshot["phase"] != "discard":
        return

    if current_snapshot.get("riichiAccepted", [False, False, False, False])[actor]:
        if actor_just_drew(current_snapshot, actor) and can_declare_tsumo(current_snapshot, actor):
            pass  # fall through to the decision engine — AI needs to decide tsumo
        elif can_ankan(current_snapshot, actor):
            pass  # fall through to the decision engine — AI needs to decide ankan
        else:
            _process_riichi_auto_tsumogiri(game, current_snapshot, actor)
            return

    debug_flow(f"[FLOW] advance_game_flow -> _process_ai_discard phase={current_snapshot['phase']} actor={actor}")
    _process_ai_discard(game, current_snapshot, actor)


def _create_play_prefetch_draft(game):
    current_node_id = game["currentNodeId"]
    current_node = copy.deepcopy(game["nodes"][current_node_id])
    current_node["parentId"] = None
    current_node["children"] = []
    current_node["mainChildId"] = None
    current_node["depth"] = 0
    return {
        key: copy.deepcopy(value)
        for key, value in game.items()
        if key not in ("nodes", "rootNodeId", "currentNodeId", "mainLeafNodeId")
    } | {
        "nodes": {current_node_id: current_node},
        "rootNodeId": current_node_id,
        "currentNodeId": current_node_id,
        "mainLeafNodeId": current_node_id,
    }


def _play_prefetch_is_user_barrier(snapshot):
    if snapshot.get("phase") in ("game_end", "round_result", "match_end"):
        return True
    return bool(build_legal_actions(snapshot, controlled_seat=STATE["controlledSeat"]))


def _play_prefetch_transition_path(game, before_node_id, after_node_id):
    if before_node_id == after_node_id:
        return []
    path = []
    cursor_id = after_node_id
    while cursor_id != before_node_id:
        node = game.get("nodes", {}).get(cursor_id)
        if not isinstance(node, dict):
            return []
        path.append(cursor_id)
        cursor_id = node.get("parentId")
        if cursor_id is None:
            return []
    path.reverse()
    return path


def _play_prefetch_actual_node_id(context, draft_node_id):
    return context.get("nodeIdMap", {}).get(draft_node_id)


def _play_prefetch_draft_node_id(context, actual_node_id):
    return next(
        (
            draft_node_id
            for draft_node_id, mapped_node_id in context.get("nodeIdMap", {}).items()
            if mapped_node_id == actual_node_id
        ),
        None,
    )


def play_prefetch_owns_opponent(actual_node_id):
    with _PLAY_PREFETCH_LOCK:
        context = _PLAY_PREFETCH_CONTEXT
        if not isinstance(context, dict):
            return False
        draft_node_id = _play_prefetch_draft_node_id(context, actual_node_id)
        return (
            draft_node_id in context.get("opponentPending", set())
            or draft_node_id in context.get("opponentResults", {})
        )


def play_prefetch_owns_decision(actual_node_id, analysis_key):
    with _PLAY_PREFETCH_LOCK:
        context = _PLAY_PREFETCH_CONTEXT
        if not isinstance(context, dict):
            return False
        draft_node_id = _play_prefetch_draft_node_id(context, actual_node_id)
        if draft_node_id is None:
            return False
        node = context.get("draftGame", {}).get("nodes", {}).get(draft_node_id)
        if not isinstance(node, dict):
            return False
        expected_key = _auto_decision_cache_key(
            context["seat"],
            node["snapshot"],
            context["modelPath"],
        )
        return expected_key == analysis_key and (
            draft_node_id in context.get("decisionPending", set())
            or draft_node_id in context.get("decisionResults", {})
        )


def _play_prefetch_current_status():
    with _PLAY_PREFETCH_LOCK:
        context = _PLAY_PREFETCH_CONTEXT
        game = STATE.get("game")
        if not isinstance(context, dict) or not isinstance(game, dict):
            return {
                "generation": 0,
                "ready": False,
                "waiting": False,
                "finished": True,
            }
        ready = False
        if context["steps"]:
            expected_id = _play_prefetch_actual_node_id(
                context,
                context["steps"][0]["beforeNodeId"],
            )
            ready = expected_id == game.get("currentNodeId")
        return {
            "generation": int(context["generation"]),
            "ready": ready,
            "waiting": not ready and bool(context.get("running")),
            "finished": bool(context.get("finished")),
            "error": context.get("error"),
        }


def cancel_play_prefetch():
    global _PLAY_PREFETCH_GENERATION, _PLAY_PREFETCH_CONTEXT

    with _PLAY_PREFETCH_LOCK:
        _PLAY_PREFETCH_GENERATION += 1
        _PLAY_PREFETCH_CONTEXT = None


def _emit_play_prefetch_ready(context, draft_node_id):
    with _PLAY_PREFETCH_LOCK:
        if _PLAY_PREFETCH_CONTEXT is not context:
            return
        actual_node_id = _play_prefetch_actual_node_id(context, draft_node_id)
        if actual_node_id is None:
            return
        payload = {
            "type": "play_prefetch_ready",
            "gameId": context["gameId"],
            "nodeId": actual_node_id,
            "generation": context["generation"],
            "timestamp": now_iso(),
        }
    emit(payload)


def _fail_play_prefetch(context, error):
    with _PLAY_PREFETCH_LOCK:
        if _PLAY_PREFETCH_CONTEXT is not context:
            return
        context["running"] = False
        context["finished"] = True
        context["error"] = str(error)
        if context["steps"]:
            notification_node_id = context["steps"][0]["beforeNodeId"]
        else:
            game = STATE.get("game")
            actual_node_id = game.get("currentNodeId") if isinstance(game, dict) else None
            notification_node_id = _play_prefetch_draft_node_id(
                context,
                actual_node_id,
            )
    if notification_node_id is not None:
        _emit_play_prefetch_ready(context, notification_node_id)


def _commit_prefetched_opponent_result(context, draft_node_id):
    result = context.get("opponentResults", {}).get(draft_node_id)
    actual_node_id = _play_prefetch_actual_node_id(context, draft_node_id)
    if not isinstance(result, dict) or actual_node_id is None:
        return False
    if draft_node_id not in context.get("committedNodeIds", set()):
        return False

    game = STATE.get("game")
    if (
        not isinstance(game, dict)
        or game.get("gameId") != context.get("gameId")
        or _PLAY_PREFETCH_CONTEXT is not context
    ):
        return False
    node = game.get("nodes", {}).get(actual_node_id)
    if not isinstance(node, dict):
        return False

    input_mode = str(context.get("opponentInputMode") or "public")
    cache_key = _build_opponent_analysis_cache_key(context["seat"], input_mode)
    cache = node.setdefault(OPPONENT_ANALYSIS_CACHE_FIELD, {})
    compact = compact_opponent_analysis(result)
    if cache.get(cache_key) == compact:
        return True
    source = _current_opponent_analysis_source(include_display_name=True)
    expected_source_id = (cache_key_context(cache_key) or {}).get("sourceId")
    if expected_source_id != source["id"]:
        return False
    register_analysis_source(game, source, result)
    prune_stale_cache_entries(cache, cache_key)
    cache[cache_key] = compact
    _set_auto_analysis_timeline_cached("opponent", actual_node_id, True)
    emit({
        "type": "record_changed",
        "gameId": context["gameId"],
        "change": "opponent_analysis_cache",
        "timestamp": now_iso(),
    })
    if (
        game.get("currentNodeId") == actual_node_id
        and STATE.get("opponentAnalysisEnabled")
    ):
        analysis_context = {
            "gameId": context["gameId"],
            "nodeId": actual_node_id,
            "seat": context["seat"],
            "inputMode": input_mode,
            "cacheKey": cache_key,
            "cacheEpoch": _OPPONENT_ANALYSIS_CACHE_EPOCH,
        }
        emit({
            "type": "opponent_analysis_ready",
            "gameId": context["gameId"],
            "nodeId": actual_node_id,
            "seat": context["seat"],
            "opponentAnalysis": attach_analysis_context(result, analysis_context),
            "timestamp": now_iso(),
        })
    return True


def _complete_play_prefetch_opponent(generation, draft_node_id, result):
    if not isinstance(result, dict) or result.get("status") != "ready":
        return
    with _STATE_LOCK:
        with _PLAY_PREFETCH_LOCK:
            context = _PLAY_PREFETCH_CONTEXT
            if (
                not isinstance(context, dict)
                or context.get("generation") != generation
            ):
                return
            context["opponentPending"].discard(draft_node_id)
            context["opponentResults"][draft_node_id] = compact_opponent_analysis(result)
        _commit_prefetched_opponent_result(context, draft_node_id)


def _schedule_play_prefetch_opponent(context, draft_node_id):
    if not STATE.get("opponentAnalysisEnabled"):
        return
    with _PLAY_PREFETCH_LOCK:
        if (
            _PLAY_PREFETCH_CONTEXT is not context
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
    prediction_bundle = get_cached_mjai_stream_bundle(
        draft_game,
        draft_node_id,
        seat,
        reveal_all=input_mode == "full-information",
    )
    target_bundle = get_cached_mjai_stream_bundle(
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
        "cacheKey": _get_opponent_analysis_cache_key(seat),
        "cacheEpoch": _OPPONENT_ANALYSIS_CACHE_EPOCH,
    }
    accepted = OPPONENT_PREDICTIONS.request_background_predict(
        snapshot,
        seat,
        input_mode=input_mode,
        context=request_context,
        on_complete=lambda result: _complete_play_prefetch_opponent(
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
        with _PLAY_PREFETCH_LOCK:
            if _PLAY_PREFETCH_CONTEXT is context:
                context["opponentPending"].discard(draft_node_id)


def _commit_prefetched_decision_result(context, draft_node_id):
    result = context.get("decisionResults", {}).get(draft_node_id)
    actual_node_id = _play_prefetch_actual_node_id(context, draft_node_id)
    if not isinstance(result, dict) or actual_node_id is None:
        return False
    if draft_node_id not in context.get("committedNodeIds", set()):
        return False

    game = STATE.get("game")
    if (
        not isinstance(game, dict)
        or game.get("gameId") != context.get("gameId")
        or _PLAY_PREFETCH_CONTEXT is not context
        or not STATE.get("decisionRecommendationsEnabled", True)
    ):
        return False
    node = game.get("nodes", {}).get(actual_node_id)
    if not isinstance(node, dict):
        return False
    cache_key = _auto_decision_cache_key(context["seat"], node["snapshot"], context["modelPath"])
    cache = node.setdefault("analysisCache", {})
    if cache.get(cache_key) == result:
        return True
    stored = _store_decision_analysis(
        game,
        node,
        cache_key,
        result,
        source=_current_decision_analysis_source(context["modelPath"]),
    )
    if stored is None:
        return False
    tree_updates = update_cached_child_comparisons(
        game,
        node,
        result,
        context["seat"],
    )
    emit({
        "type": "analysis_ready",
        "nodeId": actual_node_id,
        "gameId": context["gameId"],
        "analysisKey": cache_key,
        "analysis": copy.deepcopy(result),
        "treeComparisons": tree_updates,
        "treeRevision": int(game.get("treeRevision", 0)),
        "state": build_state_payload(consume_thinking_time=False),
        "timestamp": now_iso(),
    })
    emit({
        "type": "record_changed",
        "gameId": context["gameId"],
        "change": "decision_analysis_cache",
        "timestamp": now_iso(),
    })
    return True


def _run_play_prefetch_decision(context, draft_node_id):
    if not STATE.get("decisionRecommendationsEnabled", True):
        return
    node = context["draftGame"].get("nodes", {}).get(draft_node_id)
    if not isinstance(node, dict):
        return
    legal_actions = build_legal_actions(
        node["snapshot"],
        controlled_seat=context["seat"],
    )
    if not legal_actions:
        return
    cache_key = _auto_decision_cache_key(
        context["seat"],
        node["snapshot"],
        context["modelPath"],
    )
    with _PLAY_PREFETCH_LOCK:
        if _PLAY_PREFETCH_CONTEXT is not context:
            return
        context["decisionPending"].add(draft_node_id)
    try:
        result = _run_auto_decision_item(
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
        with _PLAY_PREFETCH_LOCK:
            if _PLAY_PREFETCH_CONTEXT is context:
                context["decisionPending"].discard(draft_node_id)
    with _STATE_LOCK:
        with _PLAY_PREFETCH_LOCK:
            if _PLAY_PREFETCH_CONTEXT is not context:
                return
            context["decisionResults"][draft_node_id] = copy.deepcopy(result)
        _commit_prefetched_decision_result(context, draft_node_id)


def _capture_play_prefetch_step(context):
    draft_game = context["draftGame"]
    before_node_id = draft_game["currentNodeId"]
    before_node = draft_game["nodes"][before_node_id]
    before_snapshot = copy.deepcopy(before_node["snapshot"])
    _PLAY_PREFETCH_LOCAL.game = draft_game
    try:
        advance_game_flow(draft_game)
    finally:
        _PLAY_PREFETCH_LOCAL.game = None

    after_node_id = draft_game["currentNodeId"]
    after_base_snapshot = copy.deepcopy(
        draft_game["nodes"][before_node_id]["snapshot"]
    )
    transition_ids = _play_prefetch_transition_path(
        draft_game,
        before_node_id,
        after_node_id,
    )
    if (
        not transition_ids
        and before_snapshot == after_base_snapshot
        and before_node_id == after_node_id
    ):
        return None

    transition_nodes = [
        copy.deepcopy(draft_game["nodes"][node_id])
        for node_id in transition_ids
    ]
    return {
        "beforeNodeId": before_node_id,
        "beforeSnapshot": before_snapshot,
        "afterBaseSnapshot": after_base_snapshot,
        "afterNodeId": after_node_id,
        "transitionNodes": transition_nodes,
        "afterMatchState": copy.deepcopy(draft_game.get("matchState")),
    }


def _run_play_prefetch(generation):
    with _PLAY_PREFETCH_LOCK:
        context = _PLAY_PREFETCH_CONTEXT
        if (
            not isinstance(context, dict)
            or context.get("generation") != generation
        ):
            return

    try:
        for _ in range(256):
            with _PLAY_PREFETCH_LOCK:
                if _PLAY_PREFETCH_CONTEXT is not context:
                    return
                draft_node_id = context["draftGame"]["currentNodeId"]
            snapshot = context["draftGame"]["nodes"][draft_node_id]["snapshot"]
            if _play_prefetch_is_user_barrier(snapshot):
                if snapshot.get("phase") not in ("game_end", "round_result", "match_end"):
                    _schedule_play_prefetch_opponent(context, draft_node_id)
                    _run_play_prefetch_decision(context, draft_node_id)
                with _PLAY_PREFETCH_LOCK:
                    if _PLAY_PREFETCH_CONTEXT is context:
                        context["running"] = False
                        context["finished"] = True
                return

            _schedule_play_prefetch_opponent(context, draft_node_id)
            step = _capture_play_prefetch_step(context)
            if step is None:
                _fail_play_prefetch(
                    context,
                    "Play prefetch could not advance the deterministic game state.",
                )
                return

            should_emit = False
            with _PLAY_PREFETCH_LOCK:
                if _PLAY_PREFETCH_CONTEXT is not context:
                    return
                should_emit = not context["steps"]
                context["steps"].append(step)
            if should_emit:
                _emit_play_prefetch_ready(context, step["beforeNodeId"])

        raise RuntimeError("Play prefetch exceeded 256 automatic steps.")
    except Exception as error:  # pylint: disable=broad-except
        _fail_play_prefetch(context, error)


def start_play_prefetch():
    global _PLAY_PREFETCH_GENERATION, _PLAY_PREFETCH_CONTEXT

    cancel_play_prefetch()
    game = STATE.get("game")
    if (
        STATE.get("mode") != "play"
        or not STATE.get("gameLoaded")
        or not isinstance(game, dict)
        or is_read_only_game(game)
        or game.get("pendingReview")
    ):
        return _play_prefetch_current_status()
    snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
    if snapshot.get("phase") in ("game_end", "round_result", "match_end"):
        return _play_prefetch_current_status()
    if _play_prefetch_is_user_barrier(snapshot):
        return _play_prefetch_current_status()

    with _PLAY_PREFETCH_LOCK:
        _PLAY_PREFETCH_GENERATION += 1
        generation = _PLAY_PREFETCH_GENERATION
        draft_game = _create_play_prefetch_draft(game)
        _PLAY_PREFETCH_CONTEXT = {
            "generation": generation,
            "gameId": game.get("gameId"),
            "seat": int(STATE["controlledSeat"]),
            "modelPath": get_action_engine_weight_path(),
            "opponentInputMode": _get_opponent_analysis_input_mode(),
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
        }
        context = _PLAY_PREFETCH_CONTEXT
    _PLAY_PREFETCH_EXECUTOR.submit(_run_play_prefetch, generation)
    return _play_prefetch_current_status()


def _commit_play_prefetch_step():
    if STATE.get("mode") != "play":
        return None
    with _PLAY_PREFETCH_LOCK:
        context = _PLAY_PREFETCH_CONTEXT
        game = STATE.get("game")
        if (
            not isinstance(context, dict)
            or not isinstance(game, dict)
            or game.get("gameId") != context.get("gameId")
            or not context["steps"]
        ):
            return None
        step = context["steps"][0]
        actual_before_id = _play_prefetch_actual_node_id(
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
        existing_id = _find_existing_child(game, actual_cursor_id, action)
        if existing_id is None:
            actual_child_id = create_node(
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
        attach_mainline(actual_cursor_id, actual_child_id)
        game["currentNodeId"] = actual_child_id
        promote_path_to_mainline(game, actual_child_id)
        with _PLAY_PREFETCH_LOCK:
            if _PLAY_PREFETCH_CONTEXT is not context:
                return None
            context["nodeIdMap"][draft_node_id] = actual_child_id
            context["committedNodeIds"].add(draft_node_id)
        committed_draft_ids.append(draft_node_id)
        actual_cursor_id = actual_child_id

    game["currentNodeId"] = actual_cursor_id
    if isinstance(step.get("afterMatchState"), dict):
        game["matchState"] = copy.deepcopy(step["afterMatchState"])
    if not step["transitionNodes"]:
        with _PLAY_PREFETCH_LOCK:
            context["committedNodeIds"].add(step["afterNodeId"])

    for draft_node_id in committed_draft_ids or [step["afterNodeId"]]:
        _commit_prefetched_opponent_result(context, draft_node_id)
        _commit_prefetched_decision_result(context, draft_node_id)

    return {
        "committed": True,
        **_play_prefetch_current_status(),
    }


def advance_game_with_prefetch(game):
    snapshot = game["nodes"][game["currentNodeId"]]["snapshot"]
    if STATE.get("mode") != "play":
        raise ValueError("Game actions are only available in play mode.")

    if snapshot.get("phase") in ("game_end", "round_result"):
        cancel_play_prefetch()
        advance_game_flow(game)
        start_play_prefetch()
        return {
            "committed": True,
            **_play_prefetch_current_status(),
        }
    if snapshot.get("phase") == "match_end":
        return {
            "committed": False,
            **_play_prefetch_current_status(),
        }

    committed = _commit_play_prefetch_step()
    if committed is not None:
        return committed

    status = _play_prefetch_current_status()
    if not status["waiting"] and not status["ready"] and not status.get("error"):
        start_play_prefetch()
        committed = _commit_play_prefetch_step()
        if committed is not None:
            return committed
        status = _play_prefetch_current_status()

    if status.get("error"):
        cancel_play_prefetch()
        advance_game_flow(game)
        start_play_prefetch()
        return {
            "committed": True,
            "fallback": True,
            **_play_prefetch_current_status(),
        }

    return {
        "committed": False,
        **status,
    }


def advance_to_next_user_turn(game):
    advance_game_flow(game)


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
    analysis_key = get_analysis_cache_key(parent_snapshot)
    ensure_analysis_cached(parent_node, parent_snapshot)

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
    training = get_training_config()
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
    analysis_key = get_analysis_cache_key(current_snapshot)
    comparison = None
    ensure_analysis_cached(current_node, current_snapshot)
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
        advance_terminal_round(game)
        return

    if action_type == "ryukyoku":
        advance_terminal_round(game)


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

    analysis_key = get_analysis_cache_key(current_snapshot)
    comparison = None
    force_commit = current_snapshot.get("pendingRiichiSeat") == actor
    ensure_analysis_cached(current_node, current_snapshot)
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
    analysis_key = get_analysis_cache_key(current_snapshot)
    comparison = None
    ensure_analysis_cached(current_node, current_snapshot)
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

    analysis_key = get_analysis_cache_key(parent_snapshot)
    ensure_analysis_cached(parent_node, parent_snapshot)
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
    _process_riichi_auto_tsumogiri(game, next_snapshot, actor)


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
    analysis_key = get_analysis_cache_key(current_snapshot)
    comparison = None
    ensure_analysis_cached(current_node, current_snapshot)
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


def create_game():
    seed = random.randint(100000, 999999)
    controlled_seat = random.randint(0, 3)
    game = create_empty_game(seed)
    reset_runtime_for_game_change()
    STATE["controlledSeat"] = controlled_seat
    STATE["pendingSeatSwitch"] = None
    STATE["game"] = game
    STATE["gameLoaded"] = True
    STATE["mode"] = "play"
    advance_to_next_user_turn(STATE["game"])

    _BG_EXECUTOR.submit(
        ACTION_RECOMMENDATIONS.prewarm,
        STATE["controlledSeat"],
        get_action_engine_weight_path(),
    )


def close_game():
    reset_runtime_for_game_change()
    STATE["game"] = None
    STATE["gameLoaded"] = False
    STATE["mode"] = "play"
    STATE["pendingSeatSwitch"] = None
    STATE["visibleHands"] = False


def import_mortal_report(report, source_url, source_import_url=None, reconstruct_walls=False, seed=None):
    game_id = f"game_{STATE['nextGameId']:04d}"
    STATE["nextGameId"] += 1
    game, controlled_seat = build_mortal_report_game(
        report,
        str(source_url or ""),
        game_id,
        now_iso(),
    )
    official_analyses = attach_mortal_review_cache(
        game,
        report,
        controlled_seat,
        _DECISION_CACHE_VERSION,
    )
    repair_reaction_decision_nodes(game)
    for node_id, analysis in official_analyses.items():
        node = game.get("nodes", {}).get(node_id)
        if isinstance(node, dict):
            update_cached_child_comparisons(game, node, analysis, controlled_seat)
    game.setdefault("treeRevision", 1)
    game["metadata"]["sourceImportUrl"] = str(source_import_url or source_url or "")
    reconstruction = None
    if reconstruct_walls:
        reconstruction = reconstruct_imported_walls(game, seed, generated_at=now_iso())
    reset_runtime_for_game_change()
    STATE["game"] = game
    STATE["gameLoaded"] = True
    STATE["mode"] = "research"
    STATE["controlledSeat"] = controlled_seat
    STATE["pendingSeatSwitch"] = None
    STATE["visibleHands"] = False
    request_current_opponent_analysis(get_current_snapshot())
    return reconstruction


def import_custom_tenhou(raw_input, reconstruct_walls=False, seed=None):
    document = normalize_custom_tenhou_input(raw_input)
    game_id = f"game_{STATE['nextGameId']:04d}"
    STATE["nextGameId"] += 1
    game, controlled_seat = build_custom_tenhou_game(
        document,
        game_id,
        now_iso(),
    )
    repair_reaction_decision_nodes(game)
    game.setdefault("treeRevision", 1)
    reconstruction = None
    if reconstruct_walls:
        reconstruction = reconstruct_imported_walls(game, seed, generated_at=now_iso())
    reset_runtime_for_game_change()
    STATE["game"] = game
    STATE["gameLoaded"] = True
    STATE["mode"] = "research"
    STATE["controlledSeat"] = controlled_seat
    STATE["pendingSeatSwitch"] = None
    STATE["visibleHands"] = False
    request_current_opponent_analysis(get_current_snapshot())
    return reconstruction


def export_current_custom_tenhou():
    ensure_game_loaded()
    return export_custom_tenhou(STATE["game"])


def reconstruct_loaded_imported_walls(seed=None):
    ensure_game_loaded()
    game = STATE["game"]
    if not is_read_only_game(game):
        raise ValueError("当前牌谱已经有完整牌山。")
    result = reconstruct_imported_walls(game, seed, generated_at=now_iso())
    game.setdefault("treeRevision", 1)
    purge_stale_mjai_stream_cache(game["gameId"])
    _invalidate_auto_analysis_timeline()
    return result


def jump_to_node(node_id):
    ensure_game_loaded()
    cancel_play_prefetch()
    game = STATE["game"]
    if node_id not in game["nodes"]:
        raise ValueError(f"Unknown node id: {node_id}")
    previous_round_root_id = resolve_round_root_id_for_node(game, game["currentNodeId"])
    game["currentNodeId"] = node_id
    game["pendingReview"] = None
    schedule_auto_analysis_reprioritization(game, node_id)
    # Sync STATE from the jumped-to snapshot so riichiDiscardState etc. are consistent
    snapshot = game["nodes"][node_id].get("snapshot")
    if snapshot and STATE.get("mode") == "research":
        sync_snapshot_state(snapshot)
        request_current_opponent_analysis(snapshot)
    return previous_round_root_id == resolve_round_root_id_for_node(game, node_id)


def set_main_branch(node_id):
    ensure_writable_game()
    game = STATE["game"]
    if node_id not in game["nodes"]:
        raise ValueError(f"Unknown node id: {node_id}")
    promote_path_to_mainline(game, node_id, force=True)


def set_node_comment(node_id, value):
    ensure_game_loaded()
    game = STATE["game"]
    node = game["nodes"].get(node_id)
    if not isinstance(node, dict):
        raise ValueError(f"Unknown node id: {node_id}")

    comment = str(value or "").replace("\r\n", "\n").replace("\r", "\n")
    if len(comment) > _NODE_COMMENT_MAX_LENGTH:
        raise ValueError(
            f"Node comment exceeds {_NODE_COMMENT_MAX_LENGTH} characters."
        )

    previous = str(node.get("comment") or "")
    if comment:
        node["comment"] = comment
    else:
        node.pop("comment", None)
    return previous != comment, comment


def delete_node(node_id):
    ensure_writable_game()
    cancel_play_prefetch()
    game = STATE["game"]
    nodes = game["nodes"]
    node = nodes.get(node_id)
    if not isinstance(node, dict):
        raise ValueError(f"Unknown node id: {node_id}")
    if node_id != game.get("currentNodeId"):
        raise ValueError("Only the current node can be deleted.")

    parent_id = node.get("parentId")
    if not parent_id or parent_id not in nodes:
        raise ValueError("The root node cannot be deleted.")

    subtree_ids = collect_subtree_ids(game, node_id)
    subtree_id_set = set(subtree_ids)
    parent = nodes[parent_id]
    remaining_children = [
        child_id
        for child_id in parent.get("children", [])
        if child_id != node_id and child_id in nodes
    ]

    cancel_auto_analysis("节点已删除")
    purge_bg_analysis_tasks(game.get("gameId"), subtree_ids)
    purge_stale_mjai_stream_cache(game.get("gameId"))

    parent["children"] = remaining_children
    if parent.get("mainChildId") == node_id:
        parent["mainChildId"] = remaining_children[0] if remaining_children else None

    for subtree_id in subtree_ids:
        nodes.pop(subtree_id, None)

    if game.get("mainLeafNodeId") in subtree_id_set:
        cursor_id = game.get("rootNodeId")
        seen = set()
        while cursor_id in nodes and cursor_id not in seen:
            seen.add(cursor_id)
            cursor = nodes[cursor_id]
            main_child_id = cursor.get("mainChildId")
            if main_child_id not in cursor.get("children", []) or main_child_id not in nodes:
                cursor["mainChildId"] = None
                break
            cursor_id = main_child_id
        game["mainLeafNodeId"] = cursor_id if cursor_id in nodes else parent_id

    game["currentNodeId"] = parent_id
    game["pendingReview"] = None
    parent_snapshot = parent.get("snapshot")
    if isinstance(parent_snapshot, dict):
        sync_snapshot_state(parent_snapshot)
        game["matchState"] = copy.deepcopy(parent_snapshot["matchState"])
        game["matchState"]["matchId"] = game.get("matchId", game.get("gameId", "game"))

    game_tree.mark_tree_changed(game)
    _invalidate_auto_analysis_timeline()
    if STATE.get("mode") == "research":
        request_current_opponent_analysis(parent_snapshot)
    return len(subtree_ids)


def clear_loaded_analysis_caches():
    global _DECISION_CACHE_EPOCH, _OPPONENT_ANALYSIS_CACHE_EPOCH
    ensure_game_loaded()
    cancel_play_prefetch()
    game = STATE["game"]
    game_id = game.get("gameId")

    cancel_auto_analysis("缓存已清除")
    _DECISION_CACHE_EPOCH += 1
    _OPPONENT_ANALYSIS_CACHE_EPOCH += 1
    purge_bg_analysis_tasks(game_id)
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
    _invalidate_auto_analysis_timeline()
    game_tree.mark_tree_changed(game)
    return {
        "decisionEntries": decision_entries,
        "opponentEntries": opponent_entries,
        "comparisons": comparisons,
        "pendingReview": had_pending_review,
        "treeRevision": int(game.get("treeRevision", 0)),
    }


def handle_command(request_id, command, payload):
    with _STATE_LOCK:
        payload = payload or {}
        training = get_training_config()
        set_thinking_time_bounds(
            float(training.get("thinkingTimeMinS", 0.25)),
            float(training.get("thinkingTimeMaxS", 1.0)),
        )
        if command == "get_status":
            return build_status_response(request_id)

        if command == "start_auto_analysis":
            auto_analysis = start_auto_analysis()
            return build_response(request_id, command, {"autoAnalysis": auto_analysis})

        if command == "cancel_auto_analysis":
            auto_analysis = cancel_auto_analysis()
            return build_response(request_id, command, {"autoAnalysis": auto_analysis})

        if command == "describe_engine":
            return build_response(
                request_id,
                command,
                {"description": describe_engine(payload)},
            )

        if command == "create_game":
            create_game()
            play_prefetch = start_play_prefetch()
            return build_response(
                request_id,
                command,
                {"playPrefetch": play_prefetch},
            )

        if command == "close_game":
            close_game()
            return build_response(request_id, command)

        if command == "import_mortal_report":
            reconstruction = import_mortal_report(
                payload.get("report"),
                payload.get("sourceUrl"),
                payload.get("sourceImportUrl"),
                bool(payload.get("reconstructWalls")),
                payload.get("seed"),
            )
            return build_response(request_id, command, {"reconstruction": reconstruction})

        if command == "import_custom_tenhou":
            reconstruction = import_custom_tenhou(
                payload.get("input"),
                bool(payload.get("reconstructWalls")),
                payload.get("seed"),
            )
            return build_response(request_id, command, {"reconstruction": reconstruction})

        if command == "export_custom_tenhou":
            return build_response(
                request_id,
                command,
                {"customTenhou": export_current_custom_tenhou()},
            )

        if run_debug_scenario(command, sys.modules[__name__]):
            return build_response(request_id, command)

        if command == "set_mode":
            ensure_game_loaded()
            next_mode = normalize_mode(payload.get("mode"))
            if next_mode == "play" and is_read_only_game():
                raise ValueError("This replay has no complete wall and cannot enter play mode.")
            cancel_play_prefetch()
            STATE["mode"] = next_mode
            if STATE["gameLoaded"] and STATE["mode"] == "research":
                request_current_opponent_analysis(get_current_snapshot())
            elif STATE["gameLoaded"] and STATE["mode"] == "play":
                start_play_prefetch()
            return build_response(request_id, command)

        if command == "set_analysis_visibility":
            if "decisionRecommendations" in payload:
                enabled = bool(payload.get("decisionRecommendations"))
                STATE["decisionRecommendationsEnabled"] = enabled
                if not enabled:
                    for future in list(_BG_TASKS.values()):
                        future.cancel()
                    game = STATE.get("game")
                    if isinstance(game, dict) and game.get("pendingReview"):
                        finalize_pending_review(confirm_proposed=True)

            if "opponentAnalysis" in payload:
                enabled = bool(payload.get("opponentAnalysis"))
                STATE["opponentAnalysisEnabled"] = enabled
                if enabled and STATE.get("gameLoaded"):
                    request_current_opponent_analysis(get_current_snapshot())
                elif not enabled:
                    OPPONENT_PREDICTIONS.cancel_pending()

            if STATE.get("mode") == "play" and STATE.get("gameLoaded"):
                start_play_prefetch()
            return build_response(request_id, command)

        if command == "request_seat_switch":
            seat = normalize_seat(payload.get("seat"))
            cancel_auto_analysis("主视角已切换")
            cancel_play_prefetch()
            STATE["pendingSeatSwitch"] = seat
            if STATE["gameLoaded"] and STATE["mode"] == "play":
                advance_to_next_user_turn(STATE["game"])
                normalize_current_tree_cursor(STATE["game"], STATE["controlledSeat"])
            elif STATE["mode"] != "play":
                apply_pending_seat_switch_if_ready(get_current_snapshot() if STATE["gameLoaded"] else {})
                if STATE["gameLoaded"]:
                    normalize_current_tree_cursor(STATE["game"], STATE["controlledSeat"])
                    request_current_opponent_analysis(get_current_snapshot())
            elif STATE["gameLoaded"]:
                start_play_prefetch()
            return build_response(request_id, command)

        if command == "toggle_visible_hands":
            STATE["visibleHands"] = not STATE["visibleHands"]
            if STATE["gameLoaded"] and STATE["mode"] == "research":
                request_current_opponent_analysis(get_current_snapshot())
            return build_response(request_id, command)

        if command == "get_game_view":
            return build_response(request_id, command)

        if command == "advance_game":
            ensure_play_mode()
            if STATE["game"].get("pendingReview"):
                return build_response(request_id, command)
            play_prefetch = advance_game_with_prefetch(STATE["game"])
            # Trigger asynchronous opponent analysis in research mode.
            if STATE.get("gameLoaded") and STATE.get("mode") == "research":
                snapshot = get_current_snapshot()
                request_current_opponent_analysis(snapshot)
            response = build_response(
                request_id,
                command,
                {"playPrefetch": play_prefetch},
            )
            return response

        if command == "export_game_record":
            return build_response(
                request_id,
                command,
                {
                    "record": serialize_game_record(),
                },
            )

        if command == "import_game_record":
            load_game_record(payload.get("record"))
            return build_response(request_id, command)

        if command == "jump_to_node":
            stayed_in_round = jump_to_node(str(payload.get("nodeId") or ""))
            try:
                client_tree_revision = int(payload.get("treeRevision"))
            except (TypeError, ValueError):
                client_tree_revision = None
            tree_is_current = client_tree_revision == int(STATE["game"].get("treeRevision", 0))
            return build_response(request_id, command, compact_tree=stayed_in_round and tree_is_current)

        if command == "set_main_branch":
            set_main_branch(str(payload.get("nodeId") or ""))
            return build_response(request_id, command)

        if command == "set_node_comment":
            node_id = str(payload.get("nodeId") or "")
            changed, comment = set_node_comment(node_id, payload.get("comment"))
            return {
                "request_id": request_id,
                "command": command,
                "nodeId": node_id,
                "comment": comment,
                "changed": changed,
                "timestamp": now_iso(),
            }

        if command == "delete_node":
            deleted_count = delete_node(str(payload.get("nodeId") or ""))
            return build_response(request_id, command, {"deletedCount": deleted_count})

        if command == "submit_user_action":
            ensure_play_mode()
            cancel_play_prefetch()
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
            play_prefetch = start_play_prefetch()
            return build_response(
                request_id,
                command,
                {"playPrefetch": play_prefetch},
            )

        if command == "confirm_pending_review":
            ensure_play_mode()
            cancel_play_prefetch()
            finalize_pending_review(confirm_proposed=True)
            play_prefetch = start_play_prefetch()
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
            reconstruction = reconstruct_loaded_imported_walls(payload.get("seed"))
            return build_response(request_id, command, {"reconstruction": reconstruction})

        if command == "import_wall":
            ensure_writable_game()
            tiles = payload.get("tiles")
            reset_current_round_with_full_wall(tiles)
            return build_response(request_id, command)

        if command == "get_latest_mjai_debug":
            return build_response(request_id, command, {"debug": get_latest_action_recommendation_debug()})

        if command == "get_shanten":
            return build_response(request_id, command, get_current_opponent_analysis())

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
                "description": describe_engine(payload or {}),
                "timestamp": now_iso(),
            }
        elif command == "reload_engines":
            result = reload_runtime_engines(
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
                "state": unload_runtime_engine(
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
    apply_runtime_engine_config(load_project_config())
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
