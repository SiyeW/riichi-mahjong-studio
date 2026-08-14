import copy
import threading


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
