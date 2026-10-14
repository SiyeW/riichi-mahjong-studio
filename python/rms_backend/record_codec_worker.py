"""Private pure-codec entry mode. Never imports the Studio service or engines."""

from __future__ import annotations

import gzip
import io
import os
import pickle
import queue
import struct
import sys
from threading import Thread

from .analysis_body_codec import AnalysisBodyCodec
from .record_binary import RESULT_LIMIT, inflate
from .record_codec_packets import materialize_packet, resident_size

PACKET_LIMIT = 64 * 1024 * 1024
PACKET_HEADER = struct.Struct('<Q')


def _exact(stream, length):
    data = bytearray()
    while len(data) < length:
        part = stream.read(length - len(data))
        if not part:
            if not data:
                raise EOFError('Codec parent channel closed.')
            raise ValueError('Incomplete codec packet.')
        data.extend(part)
    return bytes(data)


def read_packet(stream):
    length = PACKET_HEADER.unpack(_exact(stream, PACKET_HEADER.size))[0]
    if length > PACKET_LIMIT:
        raise ValueError('Codec packet exceeds its size limit.')
    # This channel is only an owned parent/child pipe. Record-file bytes NEVER
    # reach this parser; public file readers use bounded JSON/binary parsing.
    return pickle.loads(_exact(stream, length))


def write_packet(stream, value):
    class PacketBuffer(io.BytesIO):
        def write(self, data):
            if self.tell() + len(data) > PACKET_LIMIT:
                raise ValueError('Codec packet exceeds its size limit.')
            return super().write(data)

    buffer = PacketBuffer()
    pickle.Pickler(buffer, protocol=5).dump(value)
    data = buffer.getvalue()
    stream.write(PACKET_HEADER.pack(len(data)))
    stream.write(data)
    stream.flush()


class CodecJobs:
    """One active schema namespace; old captured data can explicitly rebind."""

    def __init__(self):
        self.namespace = None
        self.codec = None
        self._encode_checkpoint = None

    def finish(self, success):
        if not success and self._encode_checkpoint is not None:
            self.codec = AnalysisBodyCodec(self.codec.schemas[:self._encode_checkpoint])
        self._encode_checkpoint = None

    def _input(self, packet):
        if packet[0] == 'canonical-input':
            return self.codec.decode(inflate(packet[1], RESULT_LIMIT))
        return materialize_packet(packet)

    @staticmethod
    def _view_reply(canonical, fields):
        if fields is not None and (set(canonical) != set(fields) or any(
                meta[0] and canonical[key] != meta[1] for key, meta in fields.items())):
            raise ValueError('Analysis summary does not match its body.')
        return {'canonical': canonical, 'residentBytes': resident_size(canonical)}

    def run(self, operation, payload):
        if operation == 'ping':
            import sqlite3
            return {'pid': os.getpid(), 'serviceImported': 'rms_backend.service' in sys.modules,
                    'modelsImported': any(name in sys.modules for name in ('torch', 'onnxruntime')),
                    'numpyImported': 'numpy' in sys.modules,
                    'sqliteVersion': sqlite3.sqlite_version}
        if operation == 'bind':
            self.codec = AnalysisBodyCodec(payload['schemas'])
            self.namespace = payload['namespace']
            return len(self.codec.schemas)
        if self.codec is None or payload.get('namespace') != self.namespace:
            raise ValueError('Codec schema namespace is not bound.')
        if operation == 'encode':
            count = len(self.codec.schemas)
            self._encode_checkpoint = count
            result = (self._input(payload['packet']) if 'packet' in payload else payload['result'])
            if payload.get('compactOpponent'):
                from .analysis_cache import compact_opponent_analysis
                result = compact_opponent_analysis(result)
            raw = self.codec.encode(result, kind=payload.get('kind', 'opponent'),
                                    seat=payload.get('seat'))
            canonical = self.codec.decode(raw)
            return {'data': gzip.compress(raw, compresslevel=3, mtime=0),
                    'schemas': self.codec.schemas[count:], 'canonical': canonical,
                    'residentBytes': resident_size(canonical),
                    'fields': {key: [False, None] if isinstance(value, (dict, list)) else [True, value]
                               for key, value in canonical.items()}}
        if operation == 'decode':
            return self.codec.decode(inflate(payload['data'], RESULT_LIMIT))
        if operation == 'read':
            canonical = self.codec.decode(inflate(payload['data'], RESULT_LIMIT))
            return self._view_reply(canonical, payload.get('fields'))
        if operation == 'input':
            canonical = self._input(payload['packet'])
            return self._view_reply(canonical, payload.get('fields'))
        raise ValueError('Unknown codec operation.')


def main():
    jobs = queue.Queue(maxsize=1)

    def receive():
        try:
            while True:
                jobs.put(read_packet(sys.stdin.buffer))
        except Exception:
            # A codec job has no file-write/live-state obligations. Parent EOF
            # must also stop a CPU-bound job, not wait for its next pipe read.
            os._exit(0)

    Thread(target=receive, name='record-codec-parent-watch', daemon=True).start()
    handler = CodecJobs()
    while True:
        request = jobs.get()
        job_id = request.get('id') if isinstance(request, dict) else None
        try:
            if type(job_id) is not int or not isinstance(request.get('payload'), dict):
                raise ValueError('Invalid codec job.')
            result = handler.run(request.get('operation'), request['payload'])
            response = {'id': job_id, 'result': result}
        except Exception as error:  # Pure job failure does not kill the worker.
            handler.finish(False)
            response = {'id': job_id, 'error': str(error)}
        try:
            write_packet(sys.stdout.buffer, response)
            handler.finish(True)
        except ValueError as error:
            handler.finish(False)
            write_packet(sys.stdout.buffer, {'id': job_id, 'error': str(error)})
        except (BrokenPipeError, OSError):
            return


if __name__ == '__main__':
    main()
