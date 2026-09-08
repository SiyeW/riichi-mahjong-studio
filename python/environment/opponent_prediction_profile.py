"""Configuration and cache identity for an opponent-analysis engine profile."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from engine_assignments import OUTPUT_CONTRACTS_BY_ID

ENGINE_POSTPROCESSOR_VERSION = "opponent-analysis-host-v2"
DEFAULT_OUTPUT_IDS = (
    "opponent-shanten",
    "opponent-deal-in-probability",
)
ANALYSIS_OUTPUTS = tuple(
    dict(OUTPUT_CONTRACTS_BY_ID[output_id])
    for output_id in (
        *DEFAULT_OUTPUT_IDS,
        "opponent-concealed-tile-count",
        "wall-tile-count",
        "opponent-dora-count",
        "opponent-score",
        "kyoku-outcome",
        "kyoku-score-delta",
        "match-placement",
        "match-score",
    )
)


def _supported_outputs(requested: list[str] | None) -> tuple[str, ...]:
    requested_ids = requested or list(DEFAULT_OUTPUT_IDS)
    return tuple(
        output["id"]
        for output in ANALYSIS_OUTPUTS
        if output["id"] in requested_ids
    )


def _model_signature(path: Path) -> str:
    try:
        stat = path.stat()
        return f"{path.name}:{stat.st_size}:{stat.st_mtime_ns}"
    except OSError:
        return f"{path.name}:missing"


def _metadata_sha256(path: Path) -> str:
    metadata_path = path.with_name("model.json")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("file") == path.name:
            return str(metadata.get("sha256") or "").lower()
    except (OSError, ValueError):
        pass
    return ""


def _weight_sha256(path_value: str) -> str:
    try:
        digest = hashlib.sha256()
        with Path(path_value).resolve().open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return "missing"


@dataclass
class OpponentEngineProfile:
    profile_id: str
    engine_id: str
    engine_version: str
    model_id: str
    model_format: str
    model_path: Path
    expected_sha256: str
    engine_command: list[str]
    engine_cwd: str
    engine_options: dict[str, Any]
    configured_weights: list[dict[str, str]]
    device_preference: str
    input_modes: tuple[str, ...]
    enabled_outputs: tuple[str, ...]

    @classmethod
    def initial(
        cls,
        model_path: str | None,
        enabled_outputs: list[str] | None,
    ) -> "OpponentEngineProfile":
        path = Path(model_path) if model_path else Path("__unconfigured__")
        return cls(
            profile_id="",
            engine_id="",
            engine_version="",
            model_id="",
            model_format="",
            model_path=path,
            expected_sha256=_metadata_sha256(path),
            engine_command=[],
            engine_cwd="",
            engine_options={},
            configured_weights=[],
            device_preference="auto",
            input_modes=("public",),
            enabled_outputs=_supported_outputs(enabled_outputs),
        )

    @classmethod
    def configured(
        cls,
        *,
        profile_id: str,
        engine_id: str,
        engine_version: str,
        model_id: str,
        model_format: str,
        model_path: str,
        expected_sha256: str,
        input_modes: list[str] | None,
        engine_command: list[str] | None,
        engine_cwd: str | None,
        engine_options: dict[str, Any] | None,
        enabled_outputs: list[str] | None,
        weights: list[dict[str, Any]] | None,
    ) -> "OpponentEngineProfile":
        path = Path(model_path) if model_path else Path("__unconfigured__")
        if not path.is_absolute():
            path = Path.cwd() / path
        options = dict(engine_options or {})
        device = str(options.pop("device", "auto") or "auto")
        if device not in ("auto", "cpu", "cuda"):
            device = "auto"
        normalized_weights = [
            {
                "slotId": str(weight.get("slotId") or ""),
                "format": str(weight.get("format") or ""),
                "path": str(weight.get("path") or ""),
            }
            for weight in (weights or [])
            if isinstance(weight, dict)
        ]
        if not normalized_weights and model_path:
            normalized_weights = [
                {
                    "slotId": "model",
                    "format": str(model_format),
                    "path": str(path.resolve()),
                }
            ]
        modes = tuple(
            mode
            for mode in (input_modes or ["public"])
            if mode in ("public", "full-information")
        ) or ("public",)
        outputs = _supported_outputs(enabled_outputs)
        if not outputs:
            raise ValueError("at least one supported opponent output is required")
        return cls(
            profile_id=str(profile_id),
            engine_id=str(engine_id),
            engine_version=str(engine_version or "1.0.0"),
            model_id=str(model_id),
            model_format=str(model_format),
            model_path=path.resolve(),
            expected_sha256=str(expected_sha256 or "").lower(),
            engine_command=[str(part) for part in (engine_command or [])],
            engine_cwd=str(engine_cwd or ""),
            engine_options=options,
            configured_weights=normalized_weights,
            device_preference=device,
            input_modes=modes,
            enabled_outputs=outputs,
        )

    def identity_key(self) -> tuple[Any, ...]:
        return (
            self.profile_id,
            self.engine_id,
            self.engine_version,
            self.model_id,
            self.model_format,
            str(self.model_path.resolve()),
            self.expected_sha256,
            tuple(self.engine_command),
            self.engine_cwd,
            json.dumps(self.engine_options, sort_keys=True, separators=(",", ":")),
            self.input_modes,
            self.enabled_outputs,
            json.dumps(
                self.configured_weights,
                sort_keys=True,
                separators=(",", ":"),
            ),
        )

    def requested_output_contracts(self) -> list[dict[str, Any]]:
        return [
            dict(output)
            for output in ANALYSIS_OUTPUTS
            if output["id"] in self.enabled_outputs
        ]


class OpponentEngineIdentity:
    def __init__(self, profile: OpponentEngineProfile) -> None:
        self.reset(profile)

    def reset(self, profile: OpponentEngineProfile) -> None:
        self._profile = profile
        self.protocol_minor = 2
        self.supported_input_modes = profile.input_modes
        self.output_references = {
            output_id: {"id": output_id}
            for output_id in profile.enabled_outputs
        }
        self.effective_options: dict[str, Any] = {}
        self.actual_device = ""
        self.engine_fingerprint = ""
        self.model_signature = _model_signature(profile.model_path)

    def clear_runtime(self) -> None:
        self.engine_fingerprint = ""
        self.effective_options = {}
        self.actual_device = ""

    def accept_initialization(
        self,
        *,
        references: dict[str, dict[str, Any]],
        protocol_minor: int,
        input_modes: tuple[str, ...],
        effective_options: dict[str, Any],
        actual_device: str,
        fingerprint: str,
    ) -> None:
        self.output_references = references
        self.protocol_minor = protocol_minor
        self.supported_input_modes = input_modes
        self.effective_options = effective_options
        self.actual_device = actual_device
        self.engine_fingerprint = fingerprint

    def output_requests(self) -> list[dict[str, Any]]:
        return [
            dict(self.output_references[output_id])
            for output_id in self._profile.enabled_outputs
        ]

    def cache_identity(self) -> str:
        return self.engine_fingerprint or self.calculate_cache_identity(
            self.protocol_minor,
            self.actual_device,
            self.effective_options,
        )

    def calculate_cache_identity(
        self,
        protocol_minor: int,
        actual_device: str,
        effective_options: dict[str, Any],
    ) -> str:
        profile = self._profile
        source = {
            "engineId": profile.engine_id,
            "version": profile.engine_version,
            "protocolMajor": 2,
            "protocolMinor": protocol_minor,
            "weights": [
                {
                    "slotId": weight["slotId"],
                    "format": weight["format"],
                    "sha256": _weight_sha256(weight["path"]),
                }
                for weight in profile.configured_weights
            ],
            "device": actual_device or profile.device_preference,
            "options": effective_options or profile.engine_options,
            "outputContracts": profile.requested_output_contracts(),
            "resultSemanticsVersion": ENGINE_POSTPROCESSOR_VERSION,
        }
        encoded = json.dumps(
            source,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        return "sha256:" + hashlib.sha256(encoded).hexdigest()
