"""Owned persistent codec process with one bounded RPC in flight.

The result store supplies admission/priorities; this client never queues jobs or
silently falls back to running CPU work on the gameplay thread.
"""

from __future__ import annotations

from collections import deque
from pathlib import Path
import queue
import subprocess
import sys
from threading import Event, Lock, Thread

from .record_codec_worker import read_packet, write_packet


class CodecWorkerError(RuntimeError):
    pass


class RecordCodecClient:
    def __init__(self, *, timeout=30, command=None):
        self.timeout = timeout
        self._command = command
        self._lock = Lock()
        self._process = None
        self._responses = None
        self._threads = []
        self._stderr = deque(maxlen=32)
        self._sequence = 0
        self.generation = 0
        self._closed = False
        self._reader_stop = None

    @property
    def pid(self):
        return self._process.pid if self._process is not None else None

    def _start(self):
        if self._closed:
            raise CodecWorkerError('Record codec client is closed.')
        if self._process is not None:
            return
        command = self._command or ([sys.executable, '--record-codec-worker'] if getattr(sys, 'frozen', False)
                                    else [sys.executable, '-u', '-m', 'rms_backend', '--record-codec-worker'])
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, cwd=Path(__file__).resolve().parent.parent,
                                   creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
        self._process, self._responses = process, queue.Queue(maxsize=1)
        self.generation += 1
        responses = self._responses
        stopping = self._reader_stop = Event()

        def read_responses():
            try:
                while not stopping.is_set():
                    response = read_packet(process.stdout)
                    while not stopping.is_set():
                        try:
                            responses.put(response, timeout=.1)
                            break
                        except queue.Full:
                            continue
            except Exception as error:
                try:
                    responses.put_nowait(CodecWorkerError(str(error)))
                except queue.Full:
                    pass

        def read_errors():
            for chunk in iter(lambda: process.stderr.read(2048), b''):
                self._stderr.append(chunk.decode('utf-8', errors='replace'))

        self._threads = [Thread(target=read_responses, daemon=True, name='record-codec-result'),
                         Thread(target=read_errors, daemon=True, name='record-codec-stderr')]
        for thread in self._threads:
            thread.start()

    def call(self, operation, **payload):
        with self._lock:
            self._start()
            self._sequence += 1
            try:
                write_packet(self._process.stdin, {'id': self._sequence, 'operation': operation, 'payload': payload})
                response = self._responses.get(timeout=self.timeout)
                if isinstance(response, Exception):
                    raise response
                if not isinstance(response, dict) or response.get('id') != self._sequence:
                    raise CodecWorkerError('Record codec reply identity mismatch.')
            except (OSError, EOFError, ValueError, queue.Empty, CodecWorkerError) as error:
                self._stop()
                raise CodecWorkerError(f'Record codec channel failed: {error}') from error
            if 'error' in response:
                raise CodecWorkerError(response['error'])
            return response['result']

    def _stop(self):
        process = self._process
        if process is None:
            return
        self._reader_stop.set()
        if process.stdin:
            try:
                process.stdin.close()
            except OSError:
                pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            # Only pure codec work, never an engine or unconfirmed user write.
            process.kill()
            process.wait(timeout=2)
        for thread in self._threads:
            thread.join(timeout=2)
        for stream in (process.stdout, process.stderr):
            stream.close()
        self._process = self._responses = None
        self._threads = []

    def close(self):
        self._closed = True
        # An owned pure-codec job can be aborted; waiting for its RPC lock would
        # otherwise make shutdown wait for the full job deadline. No file/DB
        # writes live in this process. The parent keeps accepted inputs/backing.
        process = self._process
        if self._lock.locked() and process is not None and process.poll() is None:
            process.kill()
        with self._lock:
            self._stop()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
