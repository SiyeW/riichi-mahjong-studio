"""Owned compressed-byte providers; base adoption and rescue are not new codecs."""

import hashlib
import os
from threading import Lock
import tempfile
import weakref

from .record_archive import PortableBody, COPY_CHUNK
from .analysis_cache_codec import AnalysisReadError


class FileSpanSource:
    """One shared path generation for restored spans, with bounded read locks.

    An exact private copy can replace the path between chunks. No old public
    handle remains open across a yield or survives adoption to block Windows
    rename; previously captured readers follow the same immutable bytes.
    """

    def __init__(self, path):
        self.path, self._lock = path, Lock()

    def adopt(self, path):
        with self._lock:
            self.path = path

    def chunks(self, offset, length, expected):
        digest = hashlib.sha256()
        for position in range(0, length, COPY_CHUNK):
            count = min(COPY_CHUNK, length - position)
            with self._lock:
                with open(self.path, 'rb') as source:
                    source.seek(offset + position)
                    data = source.read(count)
            if len(data) != count:
                raise AnalysisReadError('Incomplete recovery base body.')
            digest.update(data)
            yield data
        if digest.digest() != expected:
            raise AnalysisReadError('Damaged recovery base body.')

    def read(self, offset, length, expected):
        return b''.join(self.chunks(offset, length, expected))

    def body(self, offset, length, digest):
        return PortableBody(length, digest, lambda: self.chunks(offset, length, digest))


class RescueBodyBacking:
    def __init__(self, data, directory):
        self._file = tempfile.TemporaryFile(dir=directory)
        self._lock = Lock()
        self.close = weakref.finalize(self, self._file.close)
        try:
            self._file.write(data)
            self._file.flush()
            os.fsync(self._file.fileno())
            original = PortableBody.from_bytes(data)
            self.body = PortableBody(original.length, original.digest, self.chunks)
        except Exception:
            self.close()
            raise

    def chunks(self):
        for position in range(0, self.body.length, COPY_CHUNK):
            with self._lock:
                self._file.seek(position)
                data = self._file.read(min(COPY_CHUNK, self.body.length - position))
            if not data:
                raise OSError('Incomplete rescue analysis backing.')
            yield data

    def read(self):
        return b''.join(self.chunks())
