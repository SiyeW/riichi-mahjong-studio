from collections import deque

from analysis_cache import OPPONENT_ANALYSIS_CACHE_FIELD


def build_round_root_map(game):
    nodes = game.get("nodes", {})
    root_map = {}
    for node_id, node in sorted(
        nodes.items(),
        key=lambda item: (int(item[1].get("depth", 0)), item[0]),
    ):
        parent_id = node.get("parentId")
        parent = nodes.get(parent_id) if parent_id else None
        if node.get("type") == "root" or not isinstance(parent, dict) or parent.get("type") == "root":
            root_map[node_id] = node_id
            continue
        snapshot = node.get("snapshot") or {}
        parent_snapshot = parent.get("snapshot") or {}
        same_round = (
            int(snapshot.get("roundIndex", 0)) == int(parent_snapshot.get("roundIndex", -1))
            and int(snapshot.get("honba", 0)) == int(parent_snapshot.get("honba", -1))
        )
        root_map[node_id] = root_map.get(parent_id, parent_id) if same_round else node_id
    return root_map


def order_rounds(game, current_node_id, round_root_map):
    nodes = game.get("nodes", {})
    roots = {
        round_root_id
        for node_id, round_root_id in round_root_map.items()
        if nodes.get(node_id, {}).get("type") != "root"
    }
    current_root_id = round_root_map.get(current_node_id)
    if current_root_id not in roots:
        return sorted(roots, key=lambda node_id: (int(nodes[node_id].get("depth", 0)), node_id))

    forward = {root_id: set() for root_id in roots}
    backward = {root_id: set() for root_id in roots}
    main_forward = {}
    for node_id, node in nodes.items():
        if node.get("type") == "root":
            continue
        source_root = round_root_map.get(node_id)
        for child_id in node.get("children", []):
            target_root = round_root_map.get(child_id)
            if not source_root or not target_root or source_root == target_root:
                continue
            forward.setdefault(source_root, set()).add(target_root)
            backward.setdefault(target_root, set()).add(source_root)

    for root_id in roots:
        cursor_id = root_id
        visited = set()
        while cursor_id and cursor_id not in visited:
            visited.add(cursor_id)
            cursor = nodes.get(cursor_id) or {}
            main_child_id = cursor.get("mainChildId")
            if not main_child_id:
                break
            target_root = round_root_map.get(main_child_id)
            if target_root != root_id:
                if target_root:
                    main_forward[root_id] = target_root
                break
            cursor_id = main_child_id

    order = []
    seen = set()
    queue = deque([current_root_id])
    while queue:
        root_id = queue.popleft()
        if root_id in seen or root_id not in roots:
            continue
        seen.add(root_id)
        order.append(root_id)
        next_ids = []
        main_next = main_forward.get(root_id)
        if main_next:
            next_ids.append(main_next)
        next_ids.extend(sorted(
            backward.get(root_id, set()),
            key=lambda node_id: (int(nodes[node_id].get("depth", 0)), node_id),
            reverse=True,
        ))
        next_ids.extend(sorted(
            forward.get(root_id, set()) - ({main_next} if main_next else set()),
            key=lambda node_id: (int(nodes[node_id].get("depth", 0)), node_id),
        ))
        queue.extend(node_id for node_id in next_ids if node_id not in seen)

    order.extend(sorted(
        roots - seen,
        key=lambda node_id: (int(nodes[node_id].get("depth", 0)), node_id),
    ))
    return order


def order_round_nodes(game, round_root_id, round_root_map):
    nodes = game.get("nodes", {})
    ordered = []
    seen = set()
    stack = [round_root_id]
    while stack:
        node_id = stack.pop()
        if node_id in seen or round_root_map.get(node_id) != round_root_id:
            continue
        node = nodes.get(node_id)
        if not isinstance(node, dict) or node.get("type") == "root":
            continue
        seen.add(node_id)
        ordered.append(node_id)
        children = [
            child_id
            for child_id in node.get("children", [])
            if round_root_map.get(child_id) == round_root_id
        ]
        main_child_id = node.get("mainChildId")
        children.sort(key=lambda child_id: (child_id != main_child_id, child_id))
        stack.extend(reversed(children))
    return ordered


def ordered_node_ids(game, start_node_id, round_root_map=None):
    resolved_root_map = round_root_map or build_round_root_map(game)
    ordered = []
    for round_root_id in order_rounds(game, start_node_id, resolved_root_map):
        ordered.extend(order_round_nodes(game, round_root_id, resolved_root_map))
    return ordered


def timeline_start_node(game, round_root_map):
    nodes = game.get("nodes", {})
    roots = {
        root_id
        for node_id, root_id in round_root_map.items()
        if nodes.get(node_id, {}).get("type") != "root"
    }
    if not roots:
        return game.get("currentNodeId")

    def sort_key(node_id):
        node = nodes.get(node_id) or {}
        snapshot = node.get("snapshot") or {}
        return (
            int(node.get("depth", 0)),
            int(snapshot.get("roundIndex", 0)),
            int(snapshot.get("honba", 0)),
            str(node_id),
        )

    return min(roots, key=sort_key)


def navigation_rank(game, start_node_id):
    ordered = ordered_node_ids(game, start_node_id)
    if start_node_id in ordered:
        ordered.remove(start_node_id)
        ordered.insert(0, start_node_id)
    return {node_id: index for index, node_id in enumerate(ordered)}


def item_key(item):
    return (item.get("kind"), item.get("nodeId"), item.get("cacheKey"))


def item_is_cached(game, item):
    node = game.get("nodes", {}).get(item.get("nodeId"))
    if not isinstance(node, dict):
        return True
    if item.get("kind") == "decision":
        result = (node.get("analysisCache") or {}).get(item.get("cacheKey"))
        return isinstance(result, dict) and not result.get("error")
    result = (node.get(OPPONENT_ANALYSIS_CACHE_FIELD) or {}).get(item.get("cacheKey"))
    return isinstance(result, dict) and result.get("status") == "ready"
