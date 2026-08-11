"""JSON-RPC/JSONL client for local model engine processes."""

from __future__ import annotations

import atexit
import json
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Callable, Optional

MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024
MAX_STDERR_LINE_CHARS = 4096
STDERR_TAIL_LINES = 100
PROTOCOL = {"name": "riichi-engine-protocol", "major": 2, "minor": 0}
HOST_ID = "riichi-mahjong-studio"
HOST_VERSION = "0.4.0-alpha.3"


class EngineProcessError(RuntimeError):
    def __init__(self, message: str, *, code: Optional[int] = None, data: Any = None):
        super().__init__(message)
        self.code = code
        self.data = data


class EngineProcessClient:
    """Own one engine process and serialize requests to its incremental state."""

    def __init__(
        self,
        engine_kind: str,
        notification_callback: Optional[Callable[[str, dict[str, Any]], None]] = None,
        *,
        command: Optional[list[str]] = None,
        cwd: Optional[str] = None,
        expected_engine_id: str = "",
        expected_engine_version: str = "",
    ):
        self._engine_kind = str(engine_kind)
        self._notification_callback = notification_callback
        self._custom_command = [str(part) for part in command] if command else None
        self._custom_cwd = str(cwd) if cwd else None
        self._expected_engine_id = str(expected_engine_id or "")
        self._expected_engine_version = str(expected_engine_version or "")
        self._lock = threading.RLock()
        self._request_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._process: Optional[subprocess.Popen[str]] = None
        self._reader: Optional[threading.Thread] = None
        self._stderr_reader: Optional[threading.Thread] = None
        self._next_request_id = 1
        self._pending: dict[str, dict[str, Any]] = {}
        self._hello: Optional[dict[str, Any]] = None
        self._initialized: Optional[dict[str, Any]] = None
        self._stderr_tail: list[str] = []
        self._stopping = False
        atexit.register(self.shutdown)

    def _command(self) -> list[str]:
        if not self._custom_command:
            raise EngineProcessError("engine file is not configured")
        command = list(self._custom_command)
        engine_file = Path(command[0])
        if engine_file.suffix.lower() != ".py":
            return command
        if getattr(sys, "frozen", False):
            raise EngineProcessError(
                "packaged applications require a standalone engine executable"
            )
        return [sys.executable, str(engine_file), *command[1:]]

    def _spawn(self) -> None:
        with self._lock:
            if self._process is not None and self._process.poll() is None:
                return
            env = self._process_environment()
            env["PYTHONUTF8"] = "1"
            env["PYTHONIOENCODING"] = "utf-8"
            env["MJAI_ENGINE_WORKER"] = self._engine_kind
            env["MJAI_TORCH_CPU_THREADS"] = env.get(
                "MJAI_ANALYSIS_CPU_THREADS",
                env.get("MJAI_TORCH_CPU_THREADS", "2"),
            )
            env.setdefault("MJAI_TORCH_INTEROP_THREADS", "1")
            creation_flags = 0
            if sys.platform == "win32":
                creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            process = subprocess.Popen(
                self._command(),
                cwd=self._custom_cwd or str(Path(__file__).resolve().parent),
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                creationflags=creation_flags,
            )
            self._process = process
            self._hello = None
            self._initialized = None
            self._stderr_tail.clear()
            self._stopping = False
            self._reader = threading.Thread(
                target=self._read_stdout,
                args=(process,),
                name=f"{self._engine_kind}-engine-reader",
                daemon=True,
            )
            self._stderr_reader = threading.Thread(
                target=self._read_stderr,
                args=(process,),
                name=f"{self._engine_kind}-engine-stderr",
                daemon=True,
            )
            self._reader.start()
            self._stderr_reader.start()

    def _process_environment(self) -> dict[str, str]:
        if self._custom_command is None:
            return dict(os.environ)
        safe_names = {
            "APPDATA",
            "COMSPEC",
            "CUDA_PATH",
            "LOCALAPPDATA",
            "NUMBER_OF_PROCESSORS",
            "PATH",
            "PATHEXT",
            "PROCESSOR_ARCHITECTURE",
            "PROGRAMDATA",
            "SYSTEMDRIVE",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "WINDIR",
        }
        return {
            key: value
            for key, value in os.environ.items()
            if key.upper() in safe_names or key.upper().startswith("CUDA_PATH_V")
        }

    def _ensure_started(self) -> None:
        self._spawn()
        if self._hello is not None:
            return
        self._hello = self._request_started(
            "engine.hello",
            {
                "protocol": dict(PROTOCOL),
                "host": {
                    "id": HOST_ID,
                    "version": HOST_VERSION,
                },
            },
            timeout=60,
        )
        protocol = self._hello.get("protocol") or {}
        if (
            protocol.get("name") != PROTOCOL["name"]
            or protocol.get("major") != PROTOCOL["major"]
            or protocol.get("minor") != PROTOCOL["minor"]
        ):
            self._stop_process()
            raise EngineProcessError("engine protocol version is not compatible")
        try:
            self._validate_hello(self._hello)
        except EngineProcessError:
            self._stop_process()
            raise
        actual_engine_id = str((self._hello.get("engine") or {}).get("id") or "")
        actual_engine_version = str((self._hello.get("engine") or {}).get("version") or "")
        if self._expected_engine_id and actual_engine_id != self._expected_engine_id:
            self._stop_process()
            raise EngineProcessError(
                "engine identity mismatch: "
                f"expected {self._expected_engine_id}, received {actual_engine_id or '(missing)'}"
            )
        if self._expected_engine_version and actual_engine_version != self._expected_engine_version:
            self._stop_process()
            raise EngineProcessError(
                "engine version mismatch: "
                f"expected {self._expected_engine_version}, "
                f"received {actual_engine_version or '(missing)'}"
            )

    @staticmethod
    def _validate_hello(hello: dict[str, Any]) -> None:
        engine = hello.get("engine")
        if not isinstance(engine, dict) or any(
            not isinstance(engine.get(field), str) or not engine.get(field)
            for field in ("id", "name", "version")
        ):
            raise EngineProcessError("engine hello contains an invalid engine identity")

        contracts = hello.get("outputContracts")
        if not isinstance(contracts, list) or not contracts:
            raise EngineProcessError("engine hello must declare at least one output contract")
        contract_keys = set()
        for contract in contracts:
            if not isinstance(contract, dict):
                raise EngineProcessError("engine hello contains an invalid output contract")
            output_id = contract.get("id")
            version = contract.get("version")
            key = (output_id, version)
            if (
                not isinstance(output_id, str)
                or not output_id
                or isinstance(version, bool)
                or not isinstance(version, int)
                or version < 1
                or key in contract_keys
            ):
                raise EngineProcessError("engine hello contains an invalid output contract")
            contract_keys.add(key)

        slots = hello.get("weightSlots")
        if not isinstance(slots, list):
            raise EngineProcessError("engine hello weightSlots must be an array")
        slot_ids = set()
        for slot in slots:
            if not isinstance(slot, dict) or not isinstance(slot.get("id"), str) or not slot["id"]:
                raise EngineProcessError("engine hello contains an invalid weight slot")
            if slot["id"] in slot_ids:
                raise EngineProcessError("engine hello contains duplicate weight slots")
            slot_ids.add(slot["id"])
            formats = slot.get("formats")
            format_ids = [
                item.get("id")
                for item in formats or []
                if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"]
            ]
            if (
                not isinstance(formats, list)
                or not formats
                or len(format_ids) != len(formats)
                or len(set(format_ids)) != len(format_ids)
            ):
                raise EngineProcessError("engine hello contains invalid weight formats")
            required = slot.get("requiredForOutputs") or []
            if not isinstance(required, list) or any(
                not isinstance(item, dict)
                or (item.get("id"), item.get("version")) not in contract_keys
                for item in required
            ):
                raise EngineProcessError("engine hello weight slot references an unknown output")

        devices = hello.get("devices")
        if not isinstance(devices, list) or not devices:
            raise EngineProcessError("engine hello must declare at least one device")
        device_types = [
            item.get("type")
            for item in devices
            if isinstance(item, dict) and isinstance(item.get("type"), str) and item["type"]
        ]
        if len(device_types) != len(devices) or len(set(device_types)) != len(device_types):
            raise EngineProcessError("engine hello contains invalid devices")

        capabilities = hello.get("runtimeCapabilities")
        capability_names = (
            "multipleSessions",
            "concurrentRequests",
            "cancellation",
        )
        if not isinstance(capabilities, dict) or any(
            not isinstance(capabilities.get(name), bool)
            for name in capability_names
        ):
            raise EngineProcessError("engine hello contains invalid runtime capabilities")
        options_schema = hello.get("optionsSchema")
        if not isinstance(options_schema, dict) or options_schema.get("type") != "object":
            raise EngineProcessError("engine hello contains an invalid options schema")

    def _read_stdout(self, process: subprocess.Popen[str]) -> None:
        assert process.stdout is not None
        try:
            while True:
                raw_line = process.stdout.readline(MAX_PROTOCOL_LINE_BYTES + 1)
                if not raw_line:
                    break
                if len(raw_line.encode("utf-8", errors="replace")) > MAX_PROTOCOL_LINE_BYTES:
                    self._fail_pending("engine emitted an oversized JSON message", process)
                    process.kill()
                    break
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    self._fail_pending("engine emitted invalid JSON", process)
                    continue
                if message.get("jsonrpc") != "2.0":
                    continue
                if "method" in message and "id" not in message:
                    callback = self._notification_callback
                    if callback is not None:
                        try:
                            callback(
                                str(message.get("method") or ""),
                                message.get("params") or {},
                            )
                        except Exception:
                            pass
                    continue
                request_id = str(message.get("id") or "")
                with self._lock:
                    pending = self._pending.pop(request_id, None)
                if pending is not None:
                    pending["response"] = message
                    pending["event"].set()
        finally:
            try:
                code = process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                code = process.poll()
            self._fail_pending(f"engine exited with code {code}", process)
            with self._lock:
                unexpected_exit = self._process is process and not self._stopping
                if self._process is process:
                    self._process = None
                    self._hello = None
                    self._initialized = None
            if unexpected_exit:
                self._notify(
                    "engine.status",
                    {
                        "state": "error",
                        "error": {
                            "code": "ENGINE_CRASHED",
                            "message": f"引擎进程意外退出（代码 {code}）",
                            "recoverable": True,
                        },
                    },
                )
            for stream in (process.stdin, process.stdout):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass

    def _read_stderr(self, process: subprocess.Popen[str]) -> None:
        assert process.stderr is not None
        try:
            while True:
                raw_line = process.stderr.readline(MAX_STDERR_LINE_CHARS + 1)
                if not raw_line:
                    break
                line = raw_line.rstrip()[:MAX_STDERR_LINE_CHARS]
                if not line:
                    continue
                with self._lock:
                    self._stderr_tail.append(line)
                    del self._stderr_tail[:-STDERR_TAIL_LINES]
                sys.stderr.write(f"[{self._engine_kind}-engine] {line}\n")
                sys.stderr.flush()
        finally:
            try:
                process.stderr.close()
            except OSError:
                pass

    def _notify(self, method: str, params: dict[str, Any]) -> None:
        callback = self._notification_callback
        if callback is None:
            return
        try:
            callback(str(method), dict(params))
        except Exception:
            pass

    def _write_message(
        self,
        process: subprocess.Popen[str],
        message: dict[str, Any],
    ) -> None:
        if process.stdin is None:
            raise EngineProcessError(f"{self._engine_kind} engine has no input pipe")
        try:
            encoded = json.dumps(
                message,
                ensure_ascii=True,
                separators=(",", ":"),
            )
            with self._write_lock:
                process.stdin.write(encoded + "\n")
                process.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise EngineProcessError(f"engine pipe failed: {exc}") from exc

    def _fail_pending(
        self,
        detail: str,
        process: Optional[subprocess.Popen[str]] = None,
    ) -> None:
        with self._lock:
            keys = [
                request_id
                for request_id, pending in self._pending.items()
                if process is None or pending.get("process") is process
            ]
            pending_items = [self._pending.pop(key) for key in keys]
        for pending in pending_items:
            pending["error"] = detail
            pending["event"].set()

    def _request_started(
        self,
        method: str,
        params: Optional[dict[str, Any]],
        *,
        timeout: float,
    ) -> dict[str, Any]:
        with self._lock:
            process = self._process
            if process is None or process.stdin is None or process.poll() is not None:
                raise EngineProcessError(f"{self._engine_kind} engine is not running")
            request_id = f"host-{self._next_request_id}"
            self._next_request_id += 1
            pending = {
                "event": threading.Event(),
                "response": None,
                "error": None,
                "process": process,
            }
            self._pending[request_id] = pending
        message = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": str(method),
            "params": params or {},
        }
        try:
            self._write_message(process, message)
        except EngineProcessError:
            with self._lock:
                self._pending.pop(request_id, None)
            raise
        if not pending["event"].wait(timeout=timeout):
            with self._lock:
                self._pending.pop(request_id, None)
            raise EngineProcessError(f"engine request timed out: {method}")
        if pending["error"]:
            raise EngineProcessError(str(pending["error"]))
        response = pending["response"] or {}
        error = response.get("error")
        if isinstance(error, dict):
            raise EngineProcessError(
                str(error.get("message") or "engine request failed"),
                code=error.get("code"),
                data=error.get("data"),
            )
        result = response.get("result")
        return result if isinstance(result, dict) else {}

    def request(
        self,
        method: str,
        params: Optional[dict[str, Any]] = None,
        *,
        timeout: float = 30.0,
    ) -> dict[str, Any]:
        with self._request_lock:
            self._ensure_started()
            return self._request_started(method, params, timeout=timeout)

    def notify(
        self,
        method: str,
        params: Optional[dict[str, Any]] = None,
    ) -> None:
        """Send a notification without waiting behind an active inference request."""
        with self._lock:
            started = (
                self._process is not None
                and self._process.poll() is None
                and self._hello is not None
            )
        if not started:
            with self._request_lock:
                self._ensure_started()
        with self._lock:
            process = self._process
            if process is None or process.poll() is not None:
                raise EngineProcessError(f"{self._engine_kind} engine is not running")
        self._write_message(
            process,
            {
                "jsonrpc": "2.0",
                "method": str(method),
                "params": params or {},
            },
        )

    def initialize(
        self,
        enabled_outputs: list[dict[str, Any]],
        weights: list[dict[str, Any]],
        *,
        device: str = "cpu",
        options: Optional[dict[str, Any]] = None,
        timeout: float = 180.0,
    ) -> dict[str, Any]:
        params = {
            "enabledOutputs": [dict(output) for output in enabled_outputs],
            "weights": [
                {
                    "slotId": str(weight.get("slotId") or ""),
                    "format": str(weight.get("format") or ""),
                    "path": str(Path(str(weight.get("path") or "")).resolve()),
                }
                for weight in weights
            ],
            "device": {"type": device},
            "options": options or {},
        }
        with self._request_lock:
            self._ensure_started()
            self._initialized = self._request_started(
                "engine.initialize",
                params,
                timeout=timeout,
            )
            return dict(self._initialized)

    @property
    def hello(self) -> Optional[dict[str, Any]]:
        return dict(self._hello) if self._hello is not None else None

    def describe(self) -> dict[str, Any]:
        """Start the engine far enough to read its authoritative hello payload."""
        with self._request_lock:
            self._ensure_started()
            return dict(self._hello or {})

    @property
    def initialized(self) -> Optional[dict[str, Any]]:
        return dict(self._initialized) if self._initialized is not None else None

    def restart(self) -> None:
        self.shutdown()

    def _stop_process(self) -> None:
        with self._lock:
            process = self._process
            self._stopping = True
            self._process = None
            self._hello = None
            self._initialized = None
        if process is None:
            return
        self._fail_pending("engine stopped", process)
        try:
            if process.stdin is not None:
                process.stdin.close()
        except OSError:
            pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        for stream in (process.stdout, process.stderr):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass

    def shutdown(self) -> None:
        with self._request_lock:
            process = self._process
            if process is not None and process.poll() is None:
                with self._lock:
                    self._stopping = True
                try:
                    self._request_started("engine.shutdown", {}, timeout=2)
                except Exception:
                    pass
            self._stop_process()
