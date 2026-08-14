import copy
import threading
from collections import deque

import auto_analysis_plan


class AutoAnalysisRuntime:
    def __init__(self):
        self.lock = threading.RLock()
        self.generation = 0
        self.future = None
        self.context = None
        self.reprioritize_timer = None
        self.reprioritize_serial = 0
        self.reprioritize_delay_s = 0.12
        self.timeline_structure_revision = 0
        self.timeline = {
            "signature": None,
            "items": [],
            "index": {},
            "states": [],
        }
        self.status = {
            "status": "idle",
            "completed": 0,
            "total": 0,
            "cached": 0,
            "analyzed": 0,
            "failed": 0,
            "currentNodeId": None,
            "currentModel": None,
            "message": "",
            "timeline": "",
            "timelineReady": 0,
        }

    def invalidate_timeline(self):
        with self.lock:
            self.timeline_structure_revision += 1
            self.timeline = {
                "signature": None,
                "items": [],
                "index": {},
                "states": [],
            }

    def timeline_matches(self, signature):
        with self.lock:
            return self.timeline.get("signature") == signature

    def replace_timeline(self, signature, items):
        with self.lock:
            self.timeline = {
                "signature": signature,
                "items": items,
                "index": {
                    (item["kind"], item["nodeId"]): index
                    for index, item in enumerate(items)
                },
                "states": [
                    ("M" if item["cached"] else "m")
                    if item["kind"] == "decision"
                    else ("O" if item["cached"] else "o")
                    for item in items
                ],
            }

    def set_timeline_cached(self, kind, node_id, cached):
        with self.lock:
            index = self.timeline["index"].get((kind, node_id))
            if index is None or index >= len(self.timeline["states"]):
                return
            if kind == "decision":
                self.timeline["states"][index] = "M" if cached else "m"
            else:
                self.timeline["states"][index] = "O" if cached else "o"

    def status_snapshot(self):
        with self.lock:
            return copy.deepcopy(self.status)

    def timeline_progress(self, active_kind, active_node_id):
        with self.lock:
            chars = list(self.timeline["states"])
            ready = sum(char in ("M", "O") for char in chars)
            active_index = self.timeline["index"].get((active_kind, active_node_id))
            if active_index is not None and active_index < len(chars):
                active_item = self.timeline["items"][active_index]
                chars[active_index] = "r" if active_item["kind"] == "decision" else "s"
            return "".join(chars), ready

    def owns_item(self, kind, node_id, current_game):
        with self.lock:
            context = self.context
            if (
                not isinstance(context, dict)
                or self.status.get("status") != "running"
                or context.get("game") is not current_game
            ):
                return False
            if (
                self.status.get("currentModel") == kind
                and self.status.get("currentNodeId") == node_id
            ):
                return True
            return any(
                item.get("kind") == kind and item.get("nodeId") == node_id
                for item in context["pending"]
            )

    def cancel(self, message):
        with self.lock:
            was_running = self.status.get("status") == "running"
            self.generation += 1
            future = self.future
            reprioritize_timer = self.reprioritize_timer
            self.future = None
            self.context = None
            self.reprioritize_timer = None
            self.reprioritize_serial += 1
            if was_running:
                self.status.update({
                    "status": "canceled",
                    "currentNodeId": None,
                    "currentModel": None,
                    "message": message,
                })
            return was_running, future, reprioritize_timer, copy.deepcopy(self.status)

    def start(self, game, seat, model_path, items, is_kind_enabled):
        cached_count = sum(1 for item in items if item["cached"])
        pending = deque(
            item
            for item in items
            if not item["cached"] and is_kind_enabled(item["kind"])
        )
        with self.lock:
            self.generation += 1
            generation = self.generation
            self.future = None
            self.context = {
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
            self.status.update({
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
            return generation

    def active_context(self, generation, game=None):
        with self.lock:
            context = self.context
            if (
                not isinstance(context, dict)
                or context.get("generation") != generation
                or self.status.get("status") != "running"
                or (game is not None and context.get("game") is not game)
            ):
                return None
            return context

    def complete_item(self, generation, item, success, error=None):
        with self.lock:
            context = self.context
            if not isinstance(context, dict) or context.get("generation") != generation:
                return None
            self.future = None
            context["attempted"].add(auto_analysis_plan.item_key(item))
            self.status["completed"] += 1
            if success:
                self.status["analyzed"] += 1
            else:
                self.status["failed"] += 1
                if error:
                    self.status["message"] = str(error)
            self.status["currentNodeId"] = None
            self.status["currentModel"] = None
            return context

    def extend_plan(self, context, items, is_kind_enabled):
        with self.lock:
            if context is not self.context:
                return False
            new_items = [
                item
                for item in items
                if auto_analysis_plan.item_key(item) not in context["known"]
            ]
            for item in new_items:
                context["known"].add(auto_analysis_plan.item_key(item))
                self.status["total"] += 1
                if item["cached"]:
                    self.status["completed"] += 1
                    self.status["cached"] += 1
                elif is_kind_enabled(item["kind"]):
                    context["pending"].append(item)
            context["treeRevision"] = int(context["game"].get("treeRevision", 0))
            return bool(new_items)

    def reprioritize_pending(
        self,
        context,
        game,
        navigation_rank,
        item_is_cached,
        is_kind_enabled,
    ):
        with self.lock:
            if context is not self.context or self.status.get("status") != "running":
                return False, False
            changed = False
            cached_updates = False
            pending = []
            for item in context["pending"]:
                key = auto_analysis_plan.item_key(item)
                if key in context["attempted"]:
                    changed = True
                    continue
                if item_is_cached(game, item):
                    context["attempted"].add(key)
                    self.status["completed"] += 1
                    self.status["cached"] += 1
                    cached_updates = True
                    changed = True
                    continue
                if not is_kind_enabled(item["kind"]):
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
                auto_analysis_plan.item_key(item)
                for item in context["pending"]
                if auto_analysis_plan.item_key(item) not in context["attempted"]
            ]:
                changed = True
            context["pending"] = next_pending
            return changed, cached_updates

    def take_next_item(self, generation, current_game, item_is_cached, is_kind_enabled):
        with self.lock:
            context = self.context
            if (
                not isinstance(context, dict)
                or context.get("generation") != generation
                or self.status.get("status") != "running"
                or context.get("game") is not current_game
            ):
                return "inactive", None, None
            game = context["game"]
            while context["pending"]:
                item = context["pending"].popleft()
                if item_is_cached(game, item):
                    context["attempted"].add(auto_analysis_plan.item_key(item))
                    self.status["completed"] += 1
                    self.status["cached"] += 1
                    continue
                if not is_kind_enabled(item["kind"]):
                    continue
                self.status["currentNodeId"] = item["nodeId"]
                self.status["currentModel"] = item["kind"]
                return "item", item, context
            return "empty", None, context

    def finish(self, generation):
        with self.lock:
            context = self.context
            if not isinstance(context, dict) or context.get("generation") != generation:
                return False
            failed = int(self.status["failed"])
            completed = int(self.status["completed"])
            total = int(self.status["total"])
            self.status.update({
                "status": "completed",
                "currentNodeId": None,
                "currentModel": None,
                "message": (
                    f"完成，{failed} 项失败"
                    if failed
                    else "分析完成" if completed == total else "可用模型分析完成"
                ),
            })
            self.context = None
            self.future = None
            return True

    def set_future(self, generation, future):
        with self.lock:
            if (
                isinstance(self.context, dict)
                and self.context.get("generation") == generation
            ):
                self.future = future
                return True
            return False

    def is_active(self, generation, game):
        return self.active_context(generation, game) is not None
