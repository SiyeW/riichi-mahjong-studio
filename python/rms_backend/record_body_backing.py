"""Failure-scoped owned bytes on the chosen Save As volume, not a new codec."""

import os
from threading import Lock
import tempfile
import weakref

from .record_archive import PortableBody, COPY_CHUNK


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
