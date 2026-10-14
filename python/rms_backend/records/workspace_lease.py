"""OS-owned writer lease. Crash/actual process exit releases the lock, not a PID guess."""

import os
from pathlib import Path


class WorkspaceLease:
    def __init__(self, path, workspace_id):
        self.path = Path(path)
        self._file = open(self.path, 'a+b')
        self._locked = False
        try:
            self._file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self._file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self._file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self._locked = True
            # Byte-range locking is allowed beyond EOF. Acquire BEFORE even
            # initializing the marker, or two creators can both append it.
            self._file.seek(0, os.SEEK_END)
            if self._file.tell() == 0:
                self._file.write(b'\0')
                self._file.flush()
            expected = workspace_id.encode('utf-8')
            self._file.seek(1)
            previous = self._file.read(1025)
            if len(expected) > 1024 or previous and previous != expected:
                raise ValueError('Recovery lease identity mismatch.')
            if not previous:
                self._file.seek(1)
                self._file.write(expected)
                self._file.flush()
                os.fsync(self._file.fileno())
        except Exception:
            self.close()
            raise

    def close(self):
        if self._file.closed:
            return
        if self._locked:
            self._file.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self._file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self._file.fileno(), fcntl.LOCK_UN)
            self._locked = False
        self._file.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
