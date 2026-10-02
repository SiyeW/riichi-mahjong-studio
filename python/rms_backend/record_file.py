"""Native record files; the host owns staging paths and atomic promotion."""

from __future__ import annotations

import gzip
import json
import os


def read_record_file(path: str) -> dict:
    with open(path, "rb") as source:
        compressed = source.read(2) == b"\x1f\x8b"
        source.seek(0)
        data = gzip.decompress(source.read()) if compressed else source.read()
    # Strict decoding must not silently replace damaged authored text.
    return json.loads(data.decode("utf-8-sig"))


def _json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _file_metadata(record, app_version, recovery):
    metadata = dict(record.get("metadata") or {})
    for field in ("models", "recovery", "app", "recordType"):
        metadata.pop(field, None)
    if app_version:
        metadata["appVersion"] = str(app_version)
    if recovery:
        metadata["recovery"] = {"kind": "unsaved-exit", "schemaVersion": 3}
    return metadata


class RecordFileWriter:
    """Single-export-lane writer retaining just the last encoded analysis block."""

    def __init__(self):
        self._analysis_source = None
        self._analysis_bytes = None

    def write(self, path: str, record: dict, *, compressed=True,
              app_version="", recovery=False) -> None:
        document = {**record, "metadata": _file_metadata(record, app_version, recovery)}
        storage = document.pop("analysisCacheStorage", None)
        if compressed and storage is not None:
            if storage is not self._analysis_source:
                encoded = gzip.compress(_json_bytes(storage), compresslevel=6, mtime=0)
                self._analysis_source, self._analysis_bytes = storage, encoded
            # Concatenated gzip members decode into the same single JSON object.
            # Recompress authored data/metadata every save, but not an unchanged
            # multi-megabyte analysis block. Existing gzip readers accept this.
            parts = (
                gzip.compress(_json_bytes(document)[:-1] + b',"analysisCacheStorage":',
                              compresslevel=6, mtime=0),
                self._analysis_bytes,
                gzip.compress(b"}", compresslevel=6, mtime=0),
            )
        else:
            self._analysis_source = self._analysis_bytes = None
            if storage is not None:
                document["analysisCacheStorage"] = storage
            data = _json_bytes(document)
            parts = (gzip.compress(data, compresslevel=6, mtime=0) if compressed else data,)
        # Never overwrite an existing staging file. The host removes a partial
        # file on failure and promotes only after durable completion.
        with open(path, "xb") as target:
            target.writelines(parts)
            target.flush()
            os.fsync(target.fileno())
