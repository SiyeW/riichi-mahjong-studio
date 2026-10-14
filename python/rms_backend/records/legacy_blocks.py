"""Indexed native records: directory first, independently loaded analysis results."""

from __future__ import annotations

import hashlib
import os
import struct
from threading import RLock

from .legacy_codec import (
    AnalysisReadError, DeferredJsonObject, EncodedJsonValue, JsonReference, index_json_array,
)
from .binary import DIRECTORY_LIMIT, RESULT_LIMIT, inflate, load_json, json_bytes
from .archive import ArchiveSource, BodyDescriptor

MAGIC = b"MJSTBLK1"
HEADER = struct.Struct("<8sQ")
CACHE_FIELDS = ("analysisCache", "opponentAnalysisCache")


def open_record_source(path):
    return open(path, 'rb')


class BlockSource(ArchiveSource):
    """Shared immutable source, released when its last result/export is released."""

    def __init__(self, file, start, prefix_digest=None, *, expected_size=None):
        if prefix_digest is None:
            position = file.tell()
            file.seek(0)
            prefix_digest = hashlib.sha256(file.read(start)).digest()
            file.seek(position)
        super().__init__(file, start, (), prefix_digest, expected_size=expected_size)

    def read_block(self, descriptor):
        if descriptor['length'] > RESULT_LIMIT + 65536:
            raise AnalysisReadError('Compressed analysis exceeds its size limit.')
        span = BodyDescriptor(descriptor['offset'], descriptor['length'], bytes.fromhex(descriptor['sha256']))
        return b''.join(self._body_chunks(span))


class BlockEntry:
    def __init__(self, source, descriptor):
        self.source, self.descriptor = source, descriptor
        self._result = None
        self.lock = RLock()

    def result(self):
        try:
            return self._load_result()
        except (OSError, EOFError, ValueError) as error:
            raise AnalysisReadError(str(error)) from error

    def _load_result(self):
        with self.lock:
            if self._result is None:
                packed = load_json(inflate(self.source.read_block(self.descriptor), RESULT_LIMIT))
                values = index_json_array(packed)
                if len(values) != 1 or not isinstance(values[0], dict):
                    raise ValueError('Invalid analysis result block.')
                result = values[0]
                fields = self.descriptor['fields']
                if list(result) != list(fields):
                    raise ValueError('Analysis block fields do not match its directory.')
                for key, metadata in fields.items():
                    if metadata[0] and result[key] != metadata[1]:
                        raise ValueError('Analysis metadata does not match its block.')
                self._result = result
            return self._result


class BlockField(JsonReference):
    def __init__(self, entry, key):
        self.entry, self.key = entry, key

    def resolve(self):
        return self.entry.result()[self.key]


class BlockResult(DeferredJsonObject):
    def __init__(self, entry):
        self.entry = entry
        fields = {key: metadata[1] if metadata[0] else BlockField(entry, key)
                  for key, metadata in entry.descriptor['fields'].items()}
        super().__init__(fields)
        self._original = fields

    def pristine(self):
        return list(self) == list(self._original) and all(
            value is self._original[key] for key, value in dict.items(self))

    @property
    def pending_io(self):
        return self.entry._result is None


def read_block_record(file, *, source_callback=None):
    """Take file ownership; no analysis payload bytes are read at this stage."""
    try:
        header = file.read(HEADER.size)
        if len(header) != HEADER.size:
            raise ValueError('Incomplete indexed record header.')
        magic, length = HEADER.unpack(header)
        size = os.fstat(file.fileno()).st_size
        if magic != MAGIC or length > DIRECTORY_LIMIT + 65536 or length > size - HEADER.size:
            raise ValueError('Invalid indexed record directory length.')
        compressed_directory = file.read(length)
        manifest = load_json(inflate(compressed_directory, DIRECTORY_LIMIT), limit=DIRECTORY_LIMIT)
        if manifest.get('version') != 1:
            raise ValueError('Unsupported indexed record version.')
        record, entries = manifest.get('record'), manifest.get('entries')
        if not isinstance(record, dict) or not isinstance(entries, list) or 'analysisCacheStorage' in record:
            raise ValueError('Invalid indexed record directory.')
        nodes = (record.get('game') or {}).get('nodes')
        if not isinstance(nodes, dict) or any(
            field in node for node in nodes.values() for field in CACHE_FIELDS
        ):
            raise ValueError('Invalid indexed record tree.')
        source = BlockSource(file, HEADER.size + length, hashlib.sha256(header + compressed_directory).digest(),
                             expected_size=size)
        offset, seen, attached = 0, set(), []
        for item in entries:
            node_id, field, key = item.get('node'), item.get('field'), item.get('key')
            block_length, fields = item.get('length'), item.get('fields')
            digest = item.get('sha256')
            identity = (node_id, field, key)
            if (node_id not in nodes or field not in CACHE_FIELDS or not isinstance(key, str)
                    or identity in seen or type(item.get('offset')) is not int or item['offset'] != offset
                    or type(block_length) is not int or block_length <= 0
                    or offset + block_length > size - source.start
                    or not isinstance(digest, str) or len(digest) != 64
                    or any(c not in '0123456789abcdef' for c in digest)
                    or not isinstance(fields, dict) or any(
                        not isinstance(metadata, list) or len(metadata) != 2
                        or type(metadata[0]) is not bool
                        or (metadata[0] and isinstance(metadata[1], (dict, list)))
                        or (not metadata[0] and metadata[1] is not None)
                        for metadata in fields.values())):
                raise ValueError('Invalid indexed analysis directory entry.')
            seen.add(identity)
            offset += block_length
            attached.append((node_id, field, key, BlockResult(BlockEntry(source, item))))
        if source.start + offset != size:
            raise ValueError('Indexed record has missing or trailing block data.')
        source.descriptors = tuple(BodyDescriptor(item['offset'], item['length'], bytes.fromhex(item['sha256']))
                                   for item in entries)
        for node_id, field, key, value in attached:
            nodes[node_id].setdefault(field, {})[key] = value
        if source_callback is not None:
            source_callback(source)
        return record
    except Exception:
        file.close()
        raise
