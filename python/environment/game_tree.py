import copy


def mark_tree_changed(game):
    game["treeRevision"] = int(game.get("treeRevision", 0)) + 1


def action_identity(action):
    action_type = str(action.get("type") or "")
    actor = action.get("actor")
    tile = str(action.get("pai") or "")
    decision_only = bool(action.get("decisionOnly"))
    if action_type == "dahai":
        return (decision_only, action_type, actor, tile, bool(action.get("tsumogiri")))
    if action_type == "hora":
        return (decision_only, action_type, actor, action.get("target"), tile)
    consumed = tuple(sorted(str(value) for value in (action.get("consumed") or [])))
    if action_type in ("chi", "pon", "daiminkan"):
        return (decision_only, action_type, actor, action.get("target"), tile, consumed)
    if action_type in ("ankan", "kakan"):
        return (decision_only, action_type, actor, tile, consumed)
    if action_type in ("reach", "reach_accepted"):
        return (decision_only, action_type, actor)
    if action_type == "ryukyoku":
        reason = str(
            action.get("reason")
            or action.get("variant")
            or action.get("reasonLabel")
            or ""
        )
        reason_aliases = {
            "流局": "exhaustive_draw",
            "荒牌流局": "exhaustive_draw",
            "九種九牌": "kyuushu_kyuuhai",
            "九种九牌": "kyuushu_kyuuhai",
            "四風連打": "suufon_renda",
            "四风连打": "suufon_renda",
            "四槓散了": "suukantsu",
            "四杠散了": "suukantsu",
            "四家立直": "suucha_riichi",
        }
        return (decision_only, action_type, reason_aliases.get(reason, reason))
    if action_type == "dora":
        return (decision_only, action_type, str(action.get("dora_marker") or ""))
    return (
        decision_only,
        action_type,
        actor,
        str(action.get("variant") or ""),
        tile,
        action.get("target"),
        consumed,
    )


def refresh_reused_imported_child(game, child_id, action, snapshot):
    child = game["nodes"].get(child_id)
    if not child:
        return False
    child_source = str((child.get("action") or {}).get("source") or "")
    incoming_source = str((action or {}).get("source") or "")
    if (
        child_source != "mortal-report"
        or incoming_source == "mortal-report"
        or child.get("snapshot") == snapshot
    ):
        return False
    child["snapshot"] = copy.deepcopy(snapshot)
    mark_tree_changed(game)
    return True


def create_node(game, parent_id, action, snapshot, *, is_decision):
    parent = game["nodes"][parent_id]
    identity = action_identity(action)
    for child_id in parent["children"]:
        child = game["nodes"][child_id]
        child_action = child.get("action") or {}
        if child_action == action or action_identity(child_action) == identity:
            child.setdefault("isDecision", is_decision)
            refresh_reused_imported_child(game, child_id, action, snapshot)
            return child_id

    node_id = f"n_{game['nextNodeIndex']}"
    game["nextNodeIndex"] += 1
    game["nodes"][node_id] = {
        "id": node_id,
        "type": "decision" if action.get("decisionOnly") else "action",
        "parentId": parent_id,
        "children": [],
        "mainChildId": None,
        "action": action,
        "actor": action.get("actor"),
        "isDecision": is_decision,
        "snapshot": snapshot,
        "analysisCache": {},
        "depth": parent["depth"] + 1,
    }
    parent["children"].append(node_id)
    mark_tree_changed(game)
    return node_id


def attach_main_child(game, parent_id, child_id, *, replace_existing):
    parent = game["nodes"][parent_id]
    if not replace_existing:
        existing_id = parent.get("mainChildId")
        if existing_id is not None and existing_id != child_id:
            return False
        changed = existing_id != child_id
        parent["mainChildId"] = child_id
        if game.get("mainLeafNodeId") == parent_id:
            game["mainLeafNodeId"] = child_id
            changed = True
        if changed:
            mark_tree_changed(game)
        return changed
    if parent.get("mainChildId") == child_id:
        return False
    parent["mainChildId"] = child_id
    mark_tree_changed(game)
    return True


def find_path_to_root(game, node_id):
    path = []
    cursor = node_id
    while cursor is not None:
        node = game["nodes"][cursor]
        path.append(cursor)
        cursor = node["parentId"]
    path.reverse()
    return path


def promote_path_to_mainline(game, node_id):
    path = find_path_to_root(game, node_id)
    changed = game.get("mainLeafNodeId") != node_id
    for parent_id, child_id in zip(path[:-1], path[1:]):
        parent = game["nodes"][parent_id]
        if parent.get("mainChildId") != child_id:
            parent["mainChildId"] = child_id
            changed = True
    game["mainLeafNodeId"] = node_id
    if changed:
        mark_tree_changed(game)
    return changed


def replace_pending_review_main_child(game, parent_id, proposed_id, chosen_id):
    if proposed_id == chosen_id:
        return False
    parent = game["nodes"][parent_id]
    if parent.get("mainChildId") != proposed_id:
        return False
    parent["mainChildId"] = chosen_id
    if game.get("mainLeafNodeId") == proposed_id:
        game["mainLeafNodeId"] = chosen_id
    mark_tree_changed(game)
    return True


def repair_main_branch_links(game):
    nodes = game.get("nodes") or {}
    pending_review = game.get("pendingReview") or {}
    review_parent_id = pending_review.get("parentNodeId")
    review_proposed_id = pending_review.get("proposedNodeId")
    changed = False
    for node_id, node in nodes.items():
        children = [child_id for child_id in node.get("children", []) if child_id in nodes]
        if node.get("mainChildId") in children:
            continue
        if node_id == review_parent_id and review_proposed_id in children:
            next_main_id = review_proposed_id
        else:
            next_main_id = children[0] if children else None
        if node.get("mainChildId") != next_main_id:
            node["mainChildId"] = next_main_id
            changed = True

    cursor_id = game.get("rootNodeId")
    seen = set()
    while cursor_id in nodes and cursor_id not in seen:
        seen.add(cursor_id)
        next_id = nodes[cursor_id].get("mainChildId")
        if next_id not in nodes:
            break
        cursor_id = next_id
    if cursor_id in nodes and game.get("mainLeafNodeId") != cursor_id:
        game["mainLeafNodeId"] = cursor_id
        changed = True
    return changed
