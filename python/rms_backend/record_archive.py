"""V2 portable container: indexed metadata and immutable compressed body spans.

The writer consumes already encoded bodies. It neither encodes predictions nor
creates a second body spool. Host promotion remains the filesystem commit point.
"""

from __future__ import annotations

from dataclasses import dataclass
import gzip
import hashlib
import os
import struct
from threading import Lock, RLock
import tempfile
import weakref

from .analysis_body_codec import AnalysisBodyCodec, POLICY
from .analysis_cache_codec import AnalysisReadError
from .record_binary import DIRECTORY_LIMIT, RESULT_LIMIT, U64, inflate, json_bytes, load_json

MAGIC = b'MJSTBLK2'
HEADER = struct.Struct('<8sQ')
BLOCK_ROW = struct.Struct('<QQ32s')
COPY_CHUNK = 256 * 1024
CACHE_FIELDS = ('analysisCache', 'opponentAnalysisCache')


@dataclass(frozen=True)
class BodyDescriptor:
    offset: int
    length: int
    digest: bytes


class ArchiveSource:
    """Own one immutable generation; copying never monopolizes position lock."""

    def __init__(self, file, start, descriptors, prefix_digest):
        self.file, self.start, self.descriptors = file, start, tuple(descriptors)
        self._prefix_digest = prefix_digest
        self._position = RLock()
        self._detach = Lock()
        self.detached = False
        self._close = weakref.finalize(self, file.close)

    def chunk(self, offset, length):
        with self._position:
            self.file.seek(offset)
            data = self.file.read(length)
        if len(data) != length:
            raise AnalysisReadError('Incomplete analysis result block.')
        return data

    def body_chunks(self, index):
        descriptor = self.descriptors[index]
        position = 0
        digest = hashlib.sha256()
        while position < descriptor.length:
            data = self.chunk(self.start + descriptor.offset + position,
                              min(COPY_CHUNK, descriptor.length - position))
            digest.update(data)
            position += len(data)
            yield data
        if digest.digest() != descriptor.digest:
            raise AnalysisReadError('Damaged analysis result block.')

    def read_body(self, index):
        descriptor = self.descriptors[index]
        if descriptor.length > RESULT_LIMIT + 65536:
            raise AnalysisReadError('Compressed analysis exceeds its size limit.')
        return b''.join(self.body_chunks(index))

    def detach(self):
        """One private exact compressed base before overwriting a pinned source."""
        with self._detach:
            if self.detached:
                return
            temporary = tempfile.TemporaryFile()
            try:
                before = os.fstat(self.file.fileno())
                signature = (before.st_size, before.st_mtime_ns, before.st_ino, before.st_dev)
                size = before.st_size
                position = 0
                prefix, body_digest, body_index = hashlib.sha256(), hashlib.sha256(), 0
                while position < size:
                    data = self.chunk(position, min(COPY_CHUNK, size - position))
                    if position < self.start:
                        prefix.update(data[:min(len(data), self.start - position)])
                    while body_index < len(self.descriptors):
                        descriptor = self.descriptors[body_index]
                        first = self.start + descriptor.offset
                        end = first + descriptor.length
                        left, right = max(0, first - position), min(len(data), end - position)
                        if left >= right:
                            break
                        body_digest.update(data[left:right])
                        if position + right != end:
                            break
                        if body_digest.digest() != descriptor.digest:
                            raise AnalysisReadError('Damaged analysis result block.')
                        body_index += 1
                        body_digest = hashlib.sha256()
                    temporary.write(data)
                    position += len(data)
                after = os.fstat(self.file.fileno())
                if (signature != (after.st_size, after.st_mtime_ns, after.st_ino, after.st_dev)
                        or prefix.digest() != self._prefix_digest
                        or body_index != len(self.descriptors)):
                    raise AnalysisReadError('Record source changed during private-base copy.')
                temporary.flush()
                with self._position:
                    self._close()
                    self.file = temporary
                    self._close = weakref.finalize(self, temporary.close)
                    self.detached = True
            except Exception:
                temporary.close()
                raise


@dataclass(frozen=True)
class PortableBody:
    """A reusable bounded compressed-byte provider, not a decoded result."""

    length: int
    digest: bytes
    chunks: object

    @classmethod
    def from_bytes(cls, data):
        return cls(len(data), hashlib.sha256(data).digest(), lambda: iter((data,)))

    @classmethod
    def from_source(cls, source, index):
        item = source.descriptors[index]
        return cls(item.length, item.digest, lambda: source.body_chunks(index))


class RecordArchive:
    """Validated front directory; no body read/decode or result memoization."""

    def __init__(self, record, entries, schemas, source, codec):
        self.record, self.entries, self.schemas, self.source = record, entries, schemas, source
        self.codec = codec

    def decode_body(self, index):
        # Runtime integration routes this pure transformation through the worker.
        return self.codec.decode(inflate(self.source.read_body(index), RESULT_LIMIT))

    def decode_entry(self, index):
        entry = self.entries[index]
        result = self.decode_body(entry['body'])
        fields = entry['fields']
        if set(result) != set(fields) or any(metadata[0] and result[key] != metadata[1]
                                             for key, metadata in fields.items()):
            raise AnalysisReadError('Analysis summary does not match its block.')
        return result


def _validate_manifest(manifest, rows):
    if (not isinstance(manifest, dict) or manifest.get('version') != 2
            or manifest.get('policy') != POLICY or type(manifest.get('blockCount')) is not int
            or manifest['blockCount'] != len(rows)):
        raise ValueError('Unsupported native record directory.')
    record, entries, schemas = manifest.get('record'), manifest.get('entries'), manifest.get('schemas')
    nodes = (record.get('game') or {}).get('nodes') if isinstance(record, dict) else None
    if (not isinstance(nodes, dict) or not isinstance(entries, list) or not isinstance(schemas, list)
            or 'analysisCacheStorage' in record or any(
                not isinstance(node, dict) or any(field in node for field in CACHE_FIELDS)
                for node in nodes.values())):
        raise ValueError('Invalid native record tree.')
    codec = AnalysisBodyCodec(schemas)  # Validate only schemas, never their bodies.
    seen = set()
    referenced = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError('Invalid native analysis entry.')
        node, field, key, body = (entry.get(name) for name in ('node', 'field', 'key', 'body'))
        fields = entry.get('fields')
        if (not isinstance(node, str) or node not in nodes or field not in CACHE_FIELDS
                or not isinstance(key, str) or type(body) is not int or not 0 <= body < len(rows)
                or (node, field, key) in seen or not isinstance(fields, dict)):
            raise ValueError('Invalid native analysis entry.')
        for metadata in fields.values():
            if (not isinstance(metadata, list) or len(metadata) != 2 or type(metadata[0]) is not bool
                    or metadata[0] and isinstance(metadata[1], (dict, list))
                    or not metadata[0] and metadata[1] is not None):
                raise ValueError('Invalid native analysis summary.')
        seen.add((node, field, key))
        referenced.add(body)
    if referenced != set(range(len(rows))):
        raise ValueError('Unreferenced native analysis body.')
    return codec


def read_archive(file):
    """Take ownership on success, close on failed candidate validation."""
    try:
        header = file.read(HEADER.size)
        if len(header) != HEADER.size:
            raise ValueError('Incomplete native record header.')
        magic, length = HEADER.unpack(header)
        size = os.fstat(file.fileno()).st_size
        if magic != MAGIC or length > DIRECTORY_LIMIT + 65536 or length > size - HEADER.size:
            raise ValueError('Invalid native record directory length.')
        compressed_directory = file.read(length)
        raw = inflate(compressed_directory, DIRECTORY_LIMIT)
        if len(raw) < U64.size:
            raise ValueError('Incomplete native record directory.')
        manifest_length = U64.unpack_from(raw)[0]
        if manifest_length > len(raw) - U64.size:
            raise ValueError('Invalid native record manifest length.')
        manifest = load_json(raw[U64.size:U64.size + manifest_length], limit=DIRECTORY_LIMIT)
        count = manifest.get('blockCount') if isinstance(manifest, dict) else None
        if type(count) is not int or count < 0 or len(raw) != U64.size + manifest_length + count * BLOCK_ROW.size:
            raise ValueError('Invalid native record block-table length.')
        rows, offset = [], 0
        for start in range(U64.size + manifest_length, len(raw), BLOCK_ROW.size):
            position, block_length, digest = BLOCK_ROW.unpack_from(raw, start)
            if position != offset or block_length <= 0 or position + block_length > size - HEADER.size - length:
                raise ValueError('Invalid native record body bounds.')
            rows.append(BodyDescriptor(position, block_length, digest))
            offset += block_length
        if HEADER.size + length + offset != size:
            raise ValueError('Native record has missing or trailing body data.')
        codec = _validate_manifest(manifest, rows)
        return RecordArchive(manifest['record'], manifest['entries'], manifest['schemas'],
                             ArchiveSource(file, HEADER.size + length, rows,
                                           hashlib.sha256(header + compressed_directory).digest()), codec)
    except Exception:
        file.close()
        raise


def write_archive(path, record, entries, schemas, bodies):
    """Stream compatible encoded providers directly to durable exclusive staging."""
    bodies = tuple(bodies)
    rows, offset = [], 0
    for body in bodies:
        if type(body.length) is not int or body.length <= 0 or len(body.digest) != 32:
            raise ValueError('Invalid encoded analysis provider.')
        rows.append(BodyDescriptor(offset, body.length, body.digest))
        offset += body.length
    manifest = {'version': 2, 'policy': POLICY, 'record': record,
                'entries': entries, 'schemas': schemas, 'blockCount': len(bodies)}
    _validate_manifest(manifest, rows)
    metadata = json_bytes(manifest)
    table = b''.join(BLOCK_ROW.pack(row.offset, row.length, row.digest) for row in rows)
    directory = U64.pack(len(metadata)) + metadata + table
    if len(directory) > DIRECTORY_LIMIT:
        raise ValueError('Native record directory exceeds its size limit.')
    directory = gzip.compress(directory, compresslevel=3, mtime=0)
    with open(path, 'xb') as target:
        target.write(HEADER.pack(MAGIC, len(directory)))
        target.write(directory)
        for body in bodies:
            digest, written = hashlib.sha256(), 0
            for chunk in body.chunks():
                if written + len(chunk) > body.length:
                    raise AnalysisReadError('Encoded analysis provider exceeded its length.')
                target.write(chunk)
                digest.update(chunk)
                written += len(chunk)
            if written != body.length or digest.digest() != body.digest:
                raise AnalysisReadError('Damaged analysis result block.')
        target.flush()
        os.fsync(target.fileno())
