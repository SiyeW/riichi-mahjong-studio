"""Test-only legacy file generation; the application writes only V2 archives."""

import gzip
import hashlib
import os
from pathlib import Path
import shutil
import tempfile

from rms_backend.records.file import read_record_file as _read_record_file, _gzip_members
from rms_backend.records.legacy_blocks import MAGIC, HEADER, CACHE_FIELDS, BlockResult
from rms_backend.records.binary import json_bytes
from rms_backend.records.legacy_codec import (
    EncodedJsonValue, JsonReference, index_json_array, json_string_seed, pack_json, raw_json_items,
)

_COMPRESSION_LEVEL = 3
_ANALYSIS_PREFIX = b',"analysisCacheStorage":'


def read_record_file(path, *, writer=None):
    """Only old writer-fixture reuse tests need the former seed adapter."""
    record = _read_record_file(path)
    if writer is not None:
        if record.origin.format == 'v1':
            writer._block_source = record.origin.source
        elif record.origin.format == 'legacy-json':
            data = Path(path).read_bytes()
            if data.startswith(bytes.fromhex('1f8b')):
                members = _gzip_members(data)
                if len(members) == 3 and members[0][0].endswith(_ANALYSIS_PREFIX):
                    writer._analysis_source = record.get('analysisCacheStorage')
                    writer._analysis_bytes = members[1][1]
    return record


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


def write_block_record(path, record, *, encoded=None):
    """Spool/copy blocks without resolving untouched file-backed predictions."""
    game = {**record['game'], 'nodes': {key: dict(node) for key, node in record['game']['nodes'].items()}}
    document = {**record, 'game': game}
    entries = []
    previous, retained = encoded or {}, {}
    with tempfile.TemporaryFile() as blocks:
        for node_id, node in game['nodes'].items():
            for field in CACHE_FIELDS:
                cache = node.pop(field, {})
                for key, result in raw_json_items(cache):
                    identity, original = (node_id, field, key), result
                    cached = previous.get(identity)
                    if isinstance(result, JsonReference):
                        result = result.resolve()
                    if cached is not None and cached[0] is original:
                        _, data, fields = cached
                        retained[identity] = cached
                    elif isinstance(result, BlockResult) and result.pristine():
                        result.entry.source.detach()
                        data = result.entry.source.read_block(result.entry.descriptor)
                        fields = result.entry.descriptor['fields']
                    else:
                        if not isinstance(result, dict):
                            raise ValueError('Analysis results must be objects.')
                        # One-time conversion/new results; never materialize an
                        # untouched block merely to export it again.
                        packed = pack_json([result], display_probabilities=True,
                                           strings_seed=json_string_seed([result]), indexed=True)
                        normalized = index_json_array(packed)[0]
                        fields = {}
                        for name, child in raw_json_items(result):
                            if isinstance(child, EncodedJsonValue):
                                scalar = not child.is_container
                            else:
                                scalar = not isinstance(child, (dict, list, JsonReference))
                            fields[name] = [True, normalized[name]] if scalar else [False, None]
                        data = gzip.compress(json_bytes(packed), compresslevel=3, mtime=0)
                        retained[identity] = (original, data, fields)
                    entries.append({'node': node_id, 'field': field, 'key': key,
                                    'offset': blocks.tell(), 'length': len(data),
                                    'sha256': hashlib.sha256(data).hexdigest(), 'fields': fields})
                    blocks.write(data)
        directory = gzip.compress(json_bytes({'version': 1, 'record': document, 'entries': entries}),
                                  compresslevel=3, mtime=0)
        with open(path, 'xb') as target:
            target.write(HEADER.pack(MAGIC, len(directory)))
            target.write(directory)
            blocks.seek(0)
            shutil.copyfileobj(blocks, target)
            target.flush()
            os.fsync(target.fileno())
    return retained
