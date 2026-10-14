"""Indexed native records: directory first, independently loaded analysis results."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import shutil
import struct
import tempfile
from threading import RLock

from .analysis_cache_codec import (
    AnalysisReadError, DeferredJsonObject, EncodedJsonValue, JsonReference, index_json_array,
    json_string_seed, pack_json, raw_json_items,
)
from .record_binary import DIRECTORY_LIMIT, RESULT_LIMIT, inflate, load_json
from .record_archive import ArchiveSource, BodyDescriptor

MAGIC = b"MJSTBLK1"
HEADER = struct.Struct("<8sQ")
CACHE_FIELDS = ("analysisCache", "opponentAnalysisCache")


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


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


def read_block_record(file, *, writer=None, source_callback=None):
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
        if writer is not None and attached:
            writer._block_source = source
        if source_callback is not None:
            source_callback(source)
        return record
    except Exception:
        file.close()
        raise


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
