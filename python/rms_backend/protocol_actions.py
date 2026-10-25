"""Translate host legal choices into complete protocol executable actions."""

import copy


_ACTION_FIELDS = {
    "dahai": ("pai", "tsumogiri"),
    "reach": (),
    "chi": ("target", "pai", "consumed"),
    "pon": ("target", "pai", "consumed"),
    "daiminkan": ("target", "pai", "consumed"),
    "ankan": ("consumed",),
    "kakan": ("pai", "consumed"),
    "hora": ("target", "pai"),
    "ryukyoku": (),
    "none": (),
}
_CONSUMED_COUNTS = {"chi": 2, "pon": 2, "daiminkan": 3, "ankan": 4, "kakan": 3}


def _position_event(events):
    for event in reversed(events):
        kind = event.get("type")
        if kind in {"start_kyoku", "hora", "ryukyoku", "end_kyoku", "end_game"}:
            break
        if kind in {"tsumo", "dahai", "ankan", "kakan"}:
            return event
    raise ValueError("candidate requires a current draw or reaction event")


def protocol_action(action, events):
    """Keep host presentation fields out; complete fields from public context."""
    kind = action["type"]
    if kind not in _ACTION_FIELDS:
        raise ValueError(f"unsupported candidate action: {kind}")
    actor = action["actor"]
    result = {"type": kind, "actor": actor}
    for key in _ACTION_FIELDS[kind]:
        if key in action and action[key] is not None:
            result[key] = copy.deepcopy(action[key])
    if kind == "dahai":
        # In the host choice representation, only drawn-tile choices carry True.
        result["tsumogiri"] = action.get("tsumogiri", False)
    elif kind == "none":
        if action.get("variant") in {"skip_ankan", "skip-ankan"}:
            result["variant"] = "skip-ankan"
            result["pai"] = action.get("pai")
            result["tsumogiri"] = True
        elif action.get("variant") not in (None, "none"):
            result["variant"] = action["variant"]
    elif kind in {"chi", "pon", "daiminkan", "hora"}:
        if "target" not in result or (kind == "hora" and "pai" not in result):
            context = _position_event(events)
            if kind != "hora" and context["type"] != "dahai":
                raise ValueError("call candidate requires a discard event")
            if kind == "hora" and action.get("variant") == "tsumo" and (
                context["type"] != "tsumo" or context["actor"] != actor
            ):
                raise ValueError("self-draw candidate requires the actor's draw event")
            result.setdefault("target", context["actor"])
            result.setdefault("pai", context.get("pai"))
    for key in _ACTION_FIELDS[kind]:
        if key not in result or result[key] is None:
            raise ValueError(f"{kind} candidate requires {key}")
    if "pai" in result and (not isinstance(result["pai"], str) or result["pai"] in ("", "?")):
        raise ValueError(f"{kind} candidate requires a physical tile")
    if "tsumogiri" in result and not isinstance(result["tsumogiri"], bool):
        raise ValueError("discard candidate requires a boolean tsumogiri flag")
    if kind in _CONSUMED_COUNTS:
        consumed = result["consumed"]
        if not isinstance(consumed, list) or len(consumed) != _CONSUMED_COUNTS[kind]:
            raise ValueError(f"{kind} candidate requires {_CONSUMED_COUNTS[kind]} consumed tiles")
        if any(not isinstance(tile, str) or tile in ("", "?") for tile in consumed):
            raise ValueError(f"{kind} candidate requires physical consumed tiles")
    return result
