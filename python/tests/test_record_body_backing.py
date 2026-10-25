import hashlib
from pathlib import Path
import tempfile
import unittest

from rms_backend.records.archive import COPY_CHUNK
from rms_backend.records.body_backing import FileSpanSource


class FileSpanSourceTests(unittest.TestCase):
    def test_captured_reader_follows_exact_base_and_does_not_lock_old_public_file_between_chunks(self):
        with tempfile.TemporaryDirectory() as directory:
            public, base = Path(directory) / 'public', Path(directory) / 'base'
            prefix = b'directory-prefix'
            data = b'a' * COPY_CHUNK + b'b' * 100
            public.write_bytes(prefix + data)
            base.write_bytes(public.read_bytes())
            source = FileSpanSource(str(public))
            body = source.body(len(prefix), len(data), hashlib.sha256(data).digest())
            chunks = body.chunks()
            first = next(chunks)
            source.adopt(str(base))
            public.unlink()  # Would fail on Windows if the old reader kept its handle across the yield.
            self.assertEqual(first + b''.join(chunks), data)
            self.assertEqual(source.read(len(prefix), len(data), body.digest), data)
