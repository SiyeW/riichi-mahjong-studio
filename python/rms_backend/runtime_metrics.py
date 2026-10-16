"""Collect cheap resident/working-set counters with consistent process ownership."""

from __future__ import annotations

import os
from typing import Any

try:
    import psutil
except ModuleNotFoundError:
    psutil = None


def _resident_memory_bytes(process: Any) -> int | None:
    if psutil is None:
        return None
    try:
        return max(0, int(process.memory_info().rss))
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return 0
    except psutil.AccessDenied:
        return None


def collect_runtime_memory_metrics(*, codec_pid=None, engine_pids=()) -> dict[str, Any]:
    if psutil is None:
        raise RuntimeError("Runtime memory metrics require psutil.")
    root = psutil.Process(os.getpid())
    totals = {'backend': _resident_memory_bytes(root), 'engine': 0, 'codec': 0}
    engine_process_count = 0
    seen = {root.pid}
    ownership_unknown = False
    try:
        descendants = root.children(recursive=True)
    except psutil.AccessDenied:
        ownership_unknown = True
        descendants = []
    except psutil.NoSuchProcess:
        descendants = []
    parents = {}
    for process in descendants:
        try:
            parents[process.pid] = process.ppid()
        except psutil.AccessDenied:
            ownership_unknown = True
            continue
        except (psutil.NoSuchProcess, psutil.ZombieProcess):
            continue

    def belongs_to(pid, owners):
        visited = set()
        while pid is not None and pid not in visited and pid != root.pid:
            if pid in owners:
                return True
            visited.add(pid)
            pid = parents.get(pid)
        return False

    engines = set(engine_pids)
    for process in descendants:
        if process.pid in seen:
            continue
        seen.add(process.pid)
        resident_bytes = _resident_memory_bytes(process)
        if resident_bytes == 0:
            continue
        if belongs_to(process.pid, {codec_pid}):
            owner = 'codec'
        elif belongs_to(process.pid, engines):
            owner = 'engine'
            engine_process_count += 1
        else:
            owner = 'backend'  # E.g. Windows console support, not an engine.
        totals[owner] = (totals[owner] + resident_bytes
                         if totals[owner] is not None and resident_bytes is not None else None)
    return {
        "memoryBasis": "resident",
        "backendResidentBytes": None if ownership_unknown else totals['backend'],
        "engineResidentBytes": None if ownership_unknown else totals['engine'],
        "engineProcessCount": None if ownership_unknown else engine_process_count,
        "codecResidentBytes": None if ownership_unknown else totals['codec'],
    }
