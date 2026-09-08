"""Collect private memory usage for the environment and engine processes."""

from __future__ import annotations

import os
from typing import Any

try:
    import psutil
except ModuleNotFoundError:
    psutil = None


def _private_memory_bytes(process: Any) -> int:
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


def collect_runtime_memory_metrics() -> dict[str, int]:
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
