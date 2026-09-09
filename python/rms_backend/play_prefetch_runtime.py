import copy
import threading


def create_draft(game):
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


def transition_path(game, before_node_id, after_node_id):
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


def actual_node_id(context, draft_node_id):
    return context.get("nodeIdMap", {}).get(draft_node_id)


def draft_node_id(context, actual_id):
    return next(
        (
            draft_id
            for draft_id, mapped_id in context.get("nodeIdMap", {}).items()
            if mapped_id == actual_id
        ),
        None,
    )


class PlayPrefetchRuntime:
    def __init__(self):
        self.lock = threading.RLock()
        self.local = threading.local()
        self.generation = 0
        self.context = None

    def cancel(self):
        with self.lock:
            self.generation += 1
            self.context = None

    def start(self, context):
        with self.lock:
            self.generation += 1
            context["generation"] = self.generation
            self.context = context
            return self.generation, context

    def active_context(self, generation=None):
        with self.lock:
            context = self.context
            if not isinstance(context, dict):
                return None
            if generation is not None and context.get("generation") != generation:
                return None
            return context

    def is_current(self, context):
        with self.lock:
            return self.context is context

    def current_status(self, game):
        with self.lock:
            context = self.context
            if not isinstance(context, dict) or not isinstance(game, dict):
                return {
                    "generation": 0,
                    "ready": False,
                    "waiting": False,
                    "finished": True,
                }
            ready = False
            if context["steps"]:
                expected_id = actual_node_id(context, context["steps"][0]["beforeNodeId"])
                ready = expected_id == game.get("currentNodeId")
            return {
                "generation": int(context["generation"]),
                "ready": ready,
                "waiting": not ready and bool(context.get("running")),
                "finished": bool(context.get("finished")),
                "error": context.get("error"),
            }

    def owns_opponent(self, actual_id):
        with self.lock:
            context = self.context
            if not isinstance(context, dict):
                return False
            draft_id = draft_node_id(context, actual_id)
            return (
                draft_id in context.get("opponentPending", set())
                or draft_id in context.get("opponentResults", {})
            )

    def owns_decision(self, actual_id, analysis_key, expected_key_for_node):
        with self.lock:
            context = self.context
            if not isinstance(context, dict):
                return False
            draft_id = draft_node_id(context, actual_id)
            if draft_id is None:
                return False
            node = context.get("draftGame", {}).get("nodes", {}).get(draft_id)
            if not isinstance(node, dict):
                return False
            expected_key = expected_key_for_node(context, node)
            return expected_key == analysis_key and (
                draft_id in context.get("decisionPending", set())
                or draft_id in context.get("decisionResults", {})
            )

    def fail(self, context, error, current_actual_id=None):
        with self.lock:
            if self.context is not context:
                return None
            context["running"] = False
            context["finished"] = True
            context["error"] = str(error)
            if context["steps"]:
                return context["steps"][0]["beforeNodeId"]
            return draft_node_id(context, current_actual_id)

    def finish(self, context):
        with self.lock:
            if self.context is not context:
                return False
            context["running"] = False
            context["finished"] = True
            return True

    def append_step(self, context, step):
        with self.lock:
            if self.context is not context:
                return None
            should_emit = not context["steps"]
            context["steps"].append(step)
            return should_emit

    def capture_step(self, context, advance_game):
        draft_game = context["draftGame"]
        before_node_id = draft_game["currentNodeId"]
        before_node = draft_game["nodes"][before_node_id]
        before_snapshot = copy.deepcopy(before_node["snapshot"])
        self.local.game = draft_game
        try:
            advance_game(draft_game)
        finally:
            self.local.game = None

        after_node_id = draft_game["currentNodeId"]
        after_base_snapshot = copy.deepcopy(
            draft_game["nodes"][before_node_id]["snapshot"]
        )
        transition_ids = transition_path(draft_game, before_node_id, after_node_id)
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
