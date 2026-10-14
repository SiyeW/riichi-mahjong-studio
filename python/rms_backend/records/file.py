"""Native record files; the host owns staging paths and atomic promotion."""

from __future__ import annotations

import copy
from dataclasses import dataclass
import hashlib
from pathlib import Path
import zlib

from .legacy_blocks import MAGIC, open_record_source, read_block_record
from .binary import LEGACY_LIMIT, load_json
from .archive import ArchiveSource, MAGIC as MAGIC_V2, read_archive

_ANALYSIS_PREFIX = b',"analysisCacheStorage":'


@dataclass(frozen=True)
class RecordOrigin:
    path: str
    format: str
    source: ArchiveSource

    def descriptor(self):
        return {'path': self.path, 'format': self.format, 'base': self.source.base_path, **self.source.identity}

    def __deepcopy__(self, _memo):
        return self


class RecordDocument(dict):
    """Owned input plus a private source identity, never persisted as user copy."""

    def __init__(self, record, origin):
        super().__init__(record)
        self.origin = origin

    def __deepcopy__(self, memo):
        result = RecordDocument({}, self.origin)
        memo[id(self)] = result
        result.update(copy.deepcopy(dict(self), memo))
        return result


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


def read_record_file(path: str) -> dict:
    """Validate one candidate, retaining immutable origin/body references."""
    source = open_record_source(path)
    try:
        return _read_record_source(source, str(Path(path).resolve()))
    except Exception:
        source.close()
        raise


def _read_record_source(source, path):
    magic = source.read(len(MAGIC))
    if magic == MAGIC_V2:
        source.seek(0)
        archive = read_archive(source)
        return RecordDocument(archive.take_record(), RecordOrigin(path, 'v2', archive.source))
    if magic == MAGIC:
        source.seek(0)
        owners = []
        record = read_block_record(source, source_callback=owners.append)
        return RecordDocument(record, RecordOrigin(path, 'v1', owners[0]))
    source.seek(0)
    data = source.read(LEGACY_LIMIT + 1)
    if len(data) > LEGACY_LIMIT:
        raise ValueError('Legacy record exceeds its input limit.')
    origin = RecordOrigin(path, 'legacy-json', ArchiveSource(source, len(data), (), hashlib.sha256(data).digest(),
                                                           expected_size=len(data)))
    # Legacy input is already fully owned in memory. Keep its identity, not an
    # unnecessary handle; an explicit base copy may reopen only this generation.
    origin.source._close()
    if data.startswith(b"\x1f\x8b"):
        members = _gzip_members(data)
        if (len(members) == 3 and members[0][0].endswith(_ANALYSIS_PREFIX)
                and members[2][0] == b"}"):
            # The writer separates these JSON values at a root-field boundary.
            # Parse each once, without joining/decoding a second giant document.
            record = load_json(members[0][0] + b"null}", limit=LEGACY_LIMIT, items_limit=16_000_000)
            storage = load_json(members[1][0], limit=LEGACY_LIMIT, items_limit=16_000_000)
            record["analysisCacheStorage"] = storage
            return RecordDocument(record, origin)
        data = b"".join(decoded for decoded, _ in members)
    # Strict decoding must not silently replace damaged authored text.
    return RecordDocument(load_json(data, limit=LEGACY_LIMIT, items_limit=16_000_000), origin)
