"""Native record files; the host owns staging paths and atomic promotion."""

from __future__ import annotations

import gzip
import os
import zlib

from .record_blocks import MAGIC, CACHE_FIELDS, open_record_source, read_block_record, write_block_record, json_bytes
from .record_binary import LEGACY_LIMIT, load_json

# Favor interactive saves over the last few percent of disk compression.
# Unchanged analysis still reuses its already-compressed block.
_COMPRESSION_LEVEL = 3


_ANALYSIS_PREFIX = b',"analysisCacheStorage":'


def _gzip_members(data):
    """Validate CRC/length once and retain each original compressed member."""
    members, produced = [], 0
    while data:
        decoder = zlib.decompressobj(wbits=31)
        try:
            decoded = decoder.decompress(data, LEGACY_LIMIT - produced + 1)
        except zlib.error as error:
            raise ValueError("Damaged compressed record.") from error
        produced += len(decoded)
        if produced > LEGACY_LIMIT or decoder.unconsumed_tail:
            raise ValueError('Record data exceeds its expansion limit.')
        if not decoder.eof:
            raise EOFError("Incomplete compressed record.")
        consumed = len(data) - len(decoder.unused_data)
        members.append((decoded, data[:consumed]))
        # gzip permits zero padding between/after members.
        data = decoder.unused_data.lstrip(b"\0")
    return members


def read_record_file(path: str, *, writer: RecordFileWriter | None = None) -> dict:
    """Read once, optionally seeding the candidate session's export writer.

    The session commits that writer only after record validation/activation.
    Analysis packing must independently confirm that its storage is unchanged.
    """
    source = open_record_source(path)
    if source.read(len(MAGIC)) == MAGIC:
        source.seek(0)
        return read_block_record(source, writer=writer)
    with source:
        source.seek(0)
        data = source.read(LEGACY_LIMIT + 1)
        if len(data) > LEGACY_LIMIT:
            raise ValueError('Legacy record exceeds its input limit.')
    if data.startswith(b"\x1f\x8b"):
        members = _gzip_members(data)
        if (len(members) == 3 and members[0][0].endswith(_ANALYSIS_PREFIX)
                and members[2][0] == b"}"):
            # The writer separates these JSON values at a root-field boundary.
            # Parse each once, without joining/decoding a second giant document.
            record = load_json(members[0][0] + b"null}", limit=LEGACY_LIMIT, items_limit=16_000_000)
            storage = load_json(members[1][0], limit=LEGACY_LIMIT, items_limit=16_000_000)
            record["analysisCacheStorage"] = storage
            if writer is not None:
                writer._analysis_source, writer._analysis_bytes = storage, members[1][1]
            return record
        data = b"".join(decoded for decoded, _ in members)
    # Strict decoding must not silently replace damaged authored text.
    return load_json(data, limit=LEGACY_LIMIT, items_limit=16_000_000)


def _json_bytes(value):
    return json_bytes(value)


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
        self._block_source = None
        self._block_encoded = {}

    def write(self, path: str, record: dict, *, compressed=True,
              app_version="", recovery=False) -> None:
        document = {**record, "metadata": _file_metadata(record, app_version, recovery)}
        if self._block_source is not None:
            self._block_source.detach()
        if compressed and isinstance(document.get('game', {}).get('nodes'), dict) and any(
            field in node for node in document['game']['nodes'].values() for field in CACHE_FIELDS
        ):
            self._analysis_source = self._analysis_bytes = None
            self._block_encoded = write_block_record(path, document, encoded=self._block_encoded)
            return
        self._block_encoded = {}
        storage = document.pop("analysisCacheStorage", None)
        if compressed and storage is not None:
            if storage is not self._analysis_source:
                encoded = gzip.compress(_json_bytes(storage), compresslevel=_COMPRESSION_LEVEL, mtime=0)
                self._analysis_source, self._analysis_bytes = storage, encoded
            # Concatenated gzip members decode into the same single JSON object.
            # Recompress authored data/metadata every save, but not an unchanged
            # multi-megabyte analysis block. Existing gzip readers accept this.
            parts = (
                gzip.compress(_json_bytes(document)[:-1] + _ANALYSIS_PREFIX,
                              compresslevel=_COMPRESSION_LEVEL, mtime=0),
                self._analysis_bytes,
                gzip.compress(b"}", compresslevel=_COMPRESSION_LEVEL, mtime=0),
            )
        else:
            self._analysis_source = self._analysis_bytes = None
            if storage is not None:
                document["analysisCacheStorage"] = storage
            data = _json_bytes(document)
            parts = (gzip.compress(data, compresslevel=_COMPRESSION_LEVEL, mtime=0) if compressed else data,)
        # Never overwrite an existing staging file. The host removes a partial
        # file on failure and promotes only after durable completion.
        with open(path, "xb") as target:
            target.writelines(parts)
            target.flush()
            os.fsync(target.fileno())
