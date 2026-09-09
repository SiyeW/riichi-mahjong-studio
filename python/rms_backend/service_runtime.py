"""Own the backend service's request executors and shutdown lifecycle."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from typing import Any


class ServiceRuntime:
    """Dispatch transport requests without leaving process resources ownerless."""

    def __init__(
        self,
        *,
        emit: Callable[[dict[str, Any]], None],
        now_iso: Callable[[], str],
        executor_factory: Callable[..., Any] = ThreadPoolExecutor,
    ) -> None:
        self._emit = emit
        self._now_iso = now_iso
        self.background = executor_factory(max_workers=1)
        self.engine_prewarm = executor_factory(max_workers=2)
        self._request_executors = {
            "command": executor_factory(max_workers=1),
            "status": executor_factory(max_workers=1),
            "metrics": executor_factory(max_workers=1),
            "engine_inspection": executor_factory(max_workers=1),
            "engine_reload": executor_factory(max_workers=1),
        }
        self._shutdown_callbacks: list[Callable[[], None]] = []
        self._closed = False

    def add_shutdown(self, callback: Callable[[], None]) -> None:
        if self._closed:
            raise RuntimeError("service runtime is already closed")
        self._shutdown_callbacks.append(callback)

    @staticmethod
    def request_lane(command: str) -> str:
        return {
            "get_status": "status",
            "get_runtime_metrics": "metrics",
            "describe_engine": "engine_inspection",
            "reload_engines": "engine_reload",
        }.get(command, "command")

    def run(
        self,
        input_stream: Iterable[str],
        *,
        service_name: str,
        configure: Callable[[], None],
        process: Callable[..., None],
    ) -> None:
        configure()
        self._emit(
            {
                "type": "service_ready",
                "service": service_name,
                "timestamp": self._now_iso(),
            }
        )
        try:
            for line in input_stream:
                self.dispatch_line(line, process)
        finally:
            self.shutdown()

    def dispatch_line(self, line: str, process: Callable[..., None]) -> None:
        message = line.strip()
        if not message:
            return
        try:
            data = json.loads(message)
            request_id = data.get("request_id")
            command = data.get("command") or ""
            payload = data.get("payload") or {}
            executor = self._request_executors[self.request_lane(command)]
            executor.submit(
                process,
                request_id,
                command,
                payload,
                lightweight_status=command == "get_status",
            )
        except Exception as error:  # pylint: disable=broad-except
            self._emit(
                {
                    "request_id": None,
                    "command": "",
                    "error": str(error),
                    "timestamp": self._now_iso(),
                }
            )

    def shutdown(self) -> None:
        if self._closed:
            return
        self._closed = True
        for callback in reversed(self._shutdown_callbacks):
            try:
                callback()
            except Exception:  # pylint: disable=broad-except
                continue
        executors = [
            self.background,
            self.engine_prewarm,
            *self._request_executors.values(),
        ]
        for executor in executors:
            executor.shutdown(wait=False, cancel_futures=True)
