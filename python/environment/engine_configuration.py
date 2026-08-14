import copy
from pathlib import Path

from engine_assignments import profiles_by_output, resolve_engine_assignments


def normalize_training_mode(mode):
    return {
        "no_review": "no_review",
        "free_play": "preview_before_click",
        "guided": "threshold_review",
        "strict": "always_review",
    }.get(str(mode or ""), str(mode or "threshold_review")) or "threshold_review"


def default_training_config():
    return {
        "mode": "threshold_review",
        "mistakeThreshold": 0.25,
        "thinkingTimeMinS": 0.25,
        "thinkingTimeMaxS": 1.0,
    }


def training_config(config):
    training = config.get("training") if isinstance(config, dict) else None
    defaults = default_training_config()
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


def resolve_resource_path(path_value, *, project_root, frozen=False, executable=None):
    raw_value = str(path_value or "")
    if not raw_value:
        return ""
    path = Path(raw_value)
    if path.is_absolute():
        return str(path)
    if frozen and path.parts and path.parts[0].lower() == "engines":
        return str(Path(executable).resolve().parents[2] / path)
    return str(Path(project_root).resolve() / path)


def resolve_command(profile, resource_resolver):
    raw_command = profile.get("engineCommand")
    if isinstance(raw_command, list) and raw_command and str(raw_command[0] or ""):
        return [
            resource_resolver(part) if index == 0 else str(part)
            for index, part in enumerate(raw_command)
        ]

    engine_path = str(profile.get("enginePath") or "")
    if engine_path:
        return [resource_resolver(engine_path)]

    return []


def resolve_cwd(profile, command, resource_resolver):
    configured_cwd = str(profile.get("engineCwd") or "")
    if configured_cwd:
        return resource_resolver(configured_cwd)
    return str(Path(command[0]).resolve().parent) if command else None


def gateway_profile(config, output_id, resource_resolver):
    profile = profiles_by_output(config).get(str(output_id or ""))
    if not isinstance(profile, dict):
        return None
    weights = [
        {
            "slotId": str(weight.get("slotId") or ""),
            "format": str(weight.get("format") or ""),
            "path": resource_resolver(weight.get("path") or ""),
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
    engine_command = resolve_command(profile, resource_resolver)
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
        "engine_cwd": resolve_cwd(profile, engine_command, resource_resolver),
        "engine_options": options,
    }


def action_engine_weight_path(config, resource_resolver):
    profile = profiles_by_output(config).get("action-recommendation")
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
    return resource_resolver(weight.get("path") or "")


def runtime_specifications(config, resource_resolver):
    specifications = []
    for assignment in resolve_engine_assignments(config):
        output_ids = assignment["outputs"]
        selected = gateway_profile(config, output_ids[0], resource_resolver) if output_ids else None
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
