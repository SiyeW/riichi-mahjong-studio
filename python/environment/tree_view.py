import copy


def normalize_seat(value):
    seat = int(value)
    if seat < 0 or seat > 3:
        raise ValueError("Seat must be between 0 and 3.")
    return seat


def node_is_visible_to_seat(node, seat):
    if node.get("type") != "decision" and not (node.get("action") or {}).get("decisionOnly"):
        return True
    try:
        actor = normalize_seat((node.get("action") or {}).get("actor"))
    except (TypeError, ValueError):
        return False
    return actor == normalize_seat(seat)


def resolve_visible_cursor(game, node_id, seat):
    nodes = game.get("nodes") or {}
    node = nodes.get(node_id)
    if not isinstance(node, dict) or node_is_visible_to_seat(node, seat):
        return node_id

    visited = set()
    cursor_id = node_id
    while cursor_id in nodes and cursor_id not in visited:
        visited.add(cursor_id)
        cursor = nodes[cursor_id]
        main_child_id = cursor.get("mainChildId")
        if main_child_id not in nodes:
            break
        if node_is_visible_to_seat(nodes[main_child_id], seat):
            return main_child_id
        cursor_id = main_child_id

    cursor_id = node.get("parentId")
    while cursor_id in nodes and cursor_id not in visited:
        visited.add(cursor_id)
        cursor = nodes[cursor_id]
        if node_is_visible_to_seat(cursor, seat):
            return cursor_id
        cursor_id = cursor.get("parentId")
    return node_id


def normalize_current_cursor(game, seat):
    current_node_id = game.get("currentNodeId")
    visible_node_id = resolve_visible_cursor(game, current_node_id, seat)
    if visible_node_id != current_node_id:
        game["currentNodeId"] = visible_node_id
        game["pendingReview"] = None
    return game.get("currentNodeId")


def build_tree_view(
    game,
    current_node_id,
    *,
    controlled_seat,
    legal_actions_resolver,
    result_info_builder,
):
    round_root_cache = {}
    round_depth_cache = {}
    projected_parent_cache = {}
    projected_children_cache = {}
    projected_main_child_cache = {}
    controlled_seat = normalize_seat(controlled_seat)

    def is_visible(node_id):
        node = game["nodes"].get(node_id)
        return isinstance(node, dict) and node_is_visible_to_seat(node, controlled_seat)

    def resolve_is_decision(node):
        cached = node.get("isDecision")
        if isinstance(cached, bool):
            return cached
        action = node.get("action") or {}
        try:
            actor = normalize_seat(action.get("actor"))
        except (TypeError, ValueError):
            return False
        if actor != controlled_seat:
            return False
        parent_id = node.get("parentId")
        if parent_id not in game["nodes"]:
            return False
        value = len(
            legal_actions_resolver(
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
                int(parent_snapshot.get("roundIndex", -1)) != int(snapshot.get("roundIndex", 0))
                or int(parent_snapshot.get("honba", -1)) != int(snapshot.get("honba", 0))
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
        scores = copy.deepcopy(snapshot.get("scores", [25000] * 4))
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
                "scores": scores if node.get("type") != "root" else [25000] * 4,
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
            "scores": copy.deepcopy(snapshot.get("scores", [25000] * 4)),
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
                result_info = result_info_builder(copy.deepcopy(cursor_snapshot))
            elif result_action_type in ("match_result", "match_end"):
                match_end_info = result_info_builder(copy.deepcopy(cursor_snapshot))
            main_child_id = cursor_node.get("mainChildId")
            if not main_child_id:
                break
            child_round_id = resolve_round_root_id(main_child_id)
            if child_round_id != round_root_id:
                next_round_id = child_round_id
                break
            cursor_id = main_child_id
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
        round_summary_cache[round_root_id]["childRoundIds"] = round_children_map.get(round_root_id, [])[:]

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


def build_cursor_view(game, current_node_id, *, controlled_seat, round_root_resolver):
    return {
        "rootNodeId": game["rootNodeId"],
        "currentNodeId": current_node_id,
        "mainLeafNodeId": game["mainLeafNodeId"],
        "currentRoundRootId": round_root_resolver(game, current_node_id),
        "revision": int(game.get("treeRevision", 0)),
        "viewSeat": normalize_seat(controlled_seat),
        "compact": True,
    }
