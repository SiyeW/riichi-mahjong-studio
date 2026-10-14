"""Record-owned immutable result versions, backed bytes and one canonical LRU.

Slot identity is not browser identity. No completed job publishes a view or
resurrects a cleared slot. Callers own per-visit subscriptions separately.
"""

from contextlib import contextmanager
from collections import OrderedDict
from concurrent.futures import Future
from dataclasses import dataclass
import hashlib
from threading import RLock
from uuid import uuid4

from .analysis_body_codec import POLICY
from .analysis_cache_codec import AnalysisReadError
from .decoded_analysis_cache import DecodedAnalysisCache
from .record_archive import PortableBody
from .record_codec_packets import result_packet
from .record_binary import RESULT_LIMIT
from .record_body_backing import RescueBodyBacking


@dataclass
class ResultVersion:
    identity: str
    slot: str
    revision: int
    epoch: int
    kind: str
    seat: int | None
    fields: dict
    raw: object = None
    read: object = None
    portable: PortableBody | None = None
    body_id: str | None = None
    pending: object = None
    error: Exception | None = None
    pins: int = 0
    reservation: object = None
    durable: object = None
    encoded: bytes | None = None
    persistence_error: Exception | None = None
    compact_opponent: bool = False
    source_codec: str = 'input'
    previous_body: str | None = None
    source_locator: dict | None = None
    rescue_backing: object = None
    source_span: tuple | None = None


class RecordResultStore:
    """Metadata methods are short; read/encode/write waits are explicitly off-lock."""

    def __init__(self, identity, scheduler, writer, *, schemas=(), budget=32 * 1024 * 1024):
        self.identity, self.scheduler, self.writer = identity, scheduler, writer
        self.schemas = list(schemas)
        self.cache = DecodedAnalysisCache(budget)
        self._lock = RLock()
        self._versions, self._slots, self._epochs = {}, {}, {}
        self._encoded_pending = 0
        self._durable_schema_count = 0
        self._closed = False
        self._clears, self._clear_failures = {}, set()
        self._orphans = OrderedDict()

    @classmethod
    def restore(cls, identity, scheduler, writer, *, index=None, budget=32 * 1024 * 1024):
        """Indexed metadata only; no BLOB SELECT, body decode or helper startup."""
        workspace = writer.ready.result()
        index = workspace.restore_index() if index is None else index
        schemas = index['schemas']
        if set(schemas) != set(range(len(schemas))):
            raise ValueError('Recovery schemas are not contiguous.')
        store = cls(identity, scheduler, writer, schemas=[schemas[key] for key in range(len(schemas))], budget=budget)
        store._durable_schema_count = len(schemas)
        bodies = {row[0]: row for row in index['bodies']}
        for slot, epoch, revision, version_id, body_id in index['slots']:
            store._epochs[slot] = epoch
            if version_id is None:
                continue
            summary = index['versionMetadata'].get(version_id) or {}
            row = bodies.get(body_id)
            if row is None:
                version = store.register(slot, fields=summary.get('fields'), kind=summary.get('kind', 'opponent'),
                                         seat=summary.get('seat'), revision=revision, epoch=epoch, identity=version_id,
                                         source_locator=summary.get('source'))
                store._versions[version].error = AnalysisReadError(
                    'Saved analysis needs its original source.' if summary.get('source')
                    else 'Analysis was not durably stored before the previous process stopped.')
                continue
            _, codec, length, digest, base, offset, namespace = row
            if codec not in (POLICY, 'packed-json-v1') or namespace != identity or not 0 < length <= RESULT_LIMIT + 65536:
                raise ValueError('Unsupported recovery analysis body owner/codec.')
            if base is None:
                read = lambda key=body_id: workspace.read_body(key)
            else:
                def read(path=base, start=offset, count=length, expected=digest):
                    with open(path, 'rb') as source:
                        source.seek(start)
                        data = source.read(count)
                    if len(data) != count or hashlib.sha256(data).digest() != expected:
                        raise AnalysisReadError('Damaged recovery base body.')
                    return data
            portable = PortableBody(length, digest, lambda read=read: iter((read(),))) if codec == POLICY else None
            if codec == 'packed-json-v1':
                read = lambda read=read, fields=summary.get('fields'): ('v1', read(), fields)
            store.register(slot, fields=summary.get('fields'), kind=summary.get('kind', 'opponent'),
                           seat=summary.get('seat'), read=read, portable=portable, body_id=body_id,
                           revision=revision, epoch=epoch, identity=version_id, source_codec=codec,
                           source_span=(base, offset, length, digest) if base is not None else None)
        return store

    def reserve(self, *, foreground=False):
        with self._lock:
            if self._closed or (not foreground and (
                    self._encoded_pending >= 8 * 1024 * 1024 or self.writer.metrics()['error'] or self._clear_failures)):
                return None
        return self.scheduler.reserve(foreground=foreground)

    def register(self, slot, *, fields, kind='opponent', seat=None, raw=None,
                 read=None, portable=None, body_id=None, revision=0, epoch=0, identity=None, source_codec='input',
                 source_locator=None, source_span=None):
        """Adopt a source reference without reading/decoding any result."""
        with self._lock:
            if self._closed or slot in self._slots:
                raise ValueError('Record slot is not available for source adoption.')
            version = ResultVersion(identity or uuid4().hex, slot, revision, epoch, kind,
                                    seat, fields, raw, read, portable, body_id, source_codec=source_codec,
                                    source_locator=source_locator, source_span=source_span)
            self._versions[version.identity] = version
            self._slots[slot] = version.identity
            self._epochs[slot] = epoch
            return version.identity

    def source_dependencies(self, path):
        with self._lock:
            return tuple(version for version in self._versions.values()
                         if (self._slots.get(version.slot) == version.identity or version.pins)
                         and (version.source_span is not None and version.source_span[0] == path
                              or version.source_locator is not None and version.source_codec == 'input'))

    def adopt_base(self, old_path, new_path):
        """Rebind file-backed readers after the exact base is durably owned."""
        with self._lock:
            for version in self._versions.values():
                if version.source_span is None or version.source_span[0] != old_path:
                    continue
                _, offset, length, digest = version.source_span
                version.source_span = (new_path, offset, length, digest)
                def read(path=new_path, start=offset, count=length, expected=digest):
                    with open(path, 'rb') as source:
                        source.seek(start)
                        data = source.read(count)
                    if len(data) != count or hashlib.sha256(data).digest() != expected:
                        raise AnalysisReadError('Damaged recovery base body.')
                    return data
                if version.source_codec == POLICY:
                    version.read = read
                    version.portable = PortableBody(length, digest, lambda read=read: iter((read(),)))
                elif version.raw is None:
                    version.read = lambda read=read, fields=version.fields: ('v1', read(), fields)

    def bind_source_input(self, identity, result):
        with self._lock:
            version = self._versions[identity]
            if version.revision or version.source_locator is None or version.portable is not None:
                return
            version.raw = result
            version.error = None

    def unbound_source_inputs(self):
        with self._lock:
            return tuple((version.identity, version.source_locator) for version in self._versions.values()
                         if version.source_locator is not None and version.raw is None and version.read is None
                         and version.portable is None and self._slots.get(version.slot) == version.identity)

    def accept(self, slot, result, *, revision, epoch, reservation, kind='opponent', seat=None):
        """Transfer immutable accepted input. Capacity must be reserved first."""
        if reservation is None or reservation.released or reservation.scheduler is not self.scheduler:
            raise ValueError('Inference result has no reserved storage capacity.')
        with self._lock:
            if self._closed or epoch != self._epochs.get(slot, epoch):
                reservation.release()
                return None
            version = ResultVersion(uuid4().hex, slot, revision, epoch, kind, seat,
                                    {}, raw=result, reservation=reservation, compact_opponent=kind == 'opponent')
            old = self._slots.get(slot)
            if old is not None:
                self._orphans[old] = None
            self._versions[version.identity] = version
            self._slots[slot] = version.identity
            self._epochs[slot] = epoch
            try:
                self.writer.submit('accept_result', revision, slot=slot, epoch=epoch,
                                   version=version.identity)
            except Exception as error:
                version.persistence_error = error
            version.pending = self.scheduler.submit_required(
                reservation, lambda lane: self._encode(version, lane))
            self._observe_failure(version)
            return version.identity

    def _observe_failure(self, version):
        def finished(future):
            if future.cancelled():
                with self._lock:
                    if version.pending is not future:
                        return
                    version.pending = None
                    reservation, version.reservation = version.reservation, None
                if reservation is not None:
                    reservation.release()
                return
            error = future.exception()
            with self._lock:
                if version.pending is future:
                    if error is not None:
                        version.error = AnalysisReadError(str(error))
                    version.pending = None
        version.pending.add_done_callback(finished)

    def _encode(self, version, lane):
        # Raw sources/files are retained on any failure. Never fall back to a
        # synchronous foreground codec or silently drop accepted user content.
        packet = result_packet(version.raw) if version.raw is not None else version.read()
        reply = lane.codec(self.identity, self.schemas, 'encode', packet=packet,
                           kind=version.kind, seat=version.seat, compactOpponent=version.compact_opponent)
        data, canonical = reply['data'], reply['canonical']
        with self._lock:
            self.schemas.extend(reply['schemas'])
            if version.source_codec != POLICY:
                version.previous_body, version.body_id = version.body_id, None
                version.source_codec = POLICY
            self._encoded_pending += len(data)
            version.fields = reply['fields']
            version.encoded = data
            version.portable = PortableBody.from_bytes(data)
            version.source_span = None
            version.read = lambda: version.encoded
            version.raw = None
            version.error = None
        self.cache.put(version.identity, canonical, reply['residentBytes'], reloadable=True)
        # Never wait for SQLite fsync on the codec lane. Demanded decodes remain
        # available even when durable writes are slow/failed. The reservation
        # remains held until the storage writer owns the accepted bytes.
        self._persist(version)
        return canonical

    def _persist(self, version):
        data = version.encoded
        length, digest = len(data), hashlib.sha256(data).digest()
        with self._lock:
            body_id = version.body_id or uuid4().hex
            version.body_id = body_id
            schema_count = len(self.schemas)
            schemas = list(enumerate(self.schemas[self._durable_schema_count:], self._durable_schema_count))
        kwargs = dict(codec=POLICY, namespace=self.identity, data=data, schemas=schemas)
        durable = Future()
        version.durable = durable
        try:
            if version.revision:
                future = self.writer.submit('store_result', version.identity, body=True, body_id=body_id,
                                            summary={'fields': version.fields, 'kind': version.kind, 'seat': version.seat}, **kwargs)
            else:
                future = self.writer.submit('cache_body', body_id, body=True, version=version.identity,
                                            slot=version.slot, epoch=version.epoch,
                                            summary={'fields': version.fields, 'kind': version.kind, 'seat': version.seat},
                                            expected_body=version.previous_body, **kwargs)
        except Exception as error:
            version.persistence_error = error
            durable.set_exception(error)
            return

        def finished(write):
            error = write.exception()
            with self._lock:
                version.persistence_error = error
                if error is not None:
                    durable.set_exception(error)
                    return  # Retain encoded bytes and admission capacity for retry/rescue.
                workspace = self.writer.ready.result()
                version.portable = PortableBody(length, digest,
                                                lambda: iter((workspace.read_body(body_id),)))
                version.read = lambda: workspace.read_body(body_id)
                version.body_id, version.encoded = body_id, None
                self._durable_schema_count = max(self._durable_schema_count, schema_count)
                self._encoded_pending -= length
                reservation, version.reservation = version.reservation, None
                version.rescue_backing = None
            if reservation is not None:
                reservation.release()
            durable.set_result(None)
        future.add_done_callback(finished)

    def retry_persistence(self, identity):
        with self._lock:
            version = self._versions[identity]
            rescue = version.rescue_backing
        if rescue is not None and version.encoded is None:
            data = rescue.read()
            with self._lock:
                if version.encoded is None:
                    version.encoded = data
                    self._encoded_pending += len(data)
        with self._lock:
            if version.encoded is None or version.durable is not None and not version.durable.done():
                return version.durable
        if version.revision:
            # Idempotent obligation retry, before its body. Never republish clear.
            self.writer.submit('accept_result', version.revision, slot=version.slot,
                               epoch=version.epoch, version=version.identity)
        self._persist(version)
        return version.durable

    def spill_failed(self, version, directory):
        """Keep accepted facts independent of a failed private volume.

        A save may release pending-result capacity only after these bytes have
        their own complete backing. The version, not the export's temporary
        lifetime, owns this file until SQLite retry succeeds or the store dies.
        """
        with self._lock:
            data = version.encoded
            if data is None:
                return version.portable
            if version.durable is None or not version.durable.done() or version.persistence_error is None:
                raise ValueError('Rescue backing is only for a confirmed private-write failure.')
        backing = RescueBodyBacking(data, directory)
        with self._lock:
            if version.encoded is not data:
                backing.close()
                return version.portable
            version.rescue_backing = backing
            version.portable, version.read = backing.body, backing.read
            version.encoded = None
            version.durable = None
            version.persistence_error = OSError(str(version.persistence_error))
            self._encoded_pending -= len(data)
            reservation, version.reservation = version.reservation, None
        if reservation is not None:
            reservation.release()
        return backing.body

    def slot(self, slot):
        with self._lock:
            return self._slots.get(slot)

    def has_slot(self, slot):
        with self._lock:
            return slot in self._epochs

    def live_slots(self):
        with self._lock:
            return tuple(self._slots.items())

    def hot(self, identity):
        return self.cache.get(identity)

    def describe(self, identity):
        with self._lock:
            version = self._versions[identity]
            return {'fields': dict(version.fields or {}), 'kind': version.kind, 'seat': version.seat,
                    'slot': version.slot, 'epoch': version.epoch, 'error': version.error,
                    'loading': version.pending is not None}

    def request(self, identity, *, group=None, prefetch=False, retry=False):
        with self._lock:
            version = self._versions[identity]
            if version.error is not None and not retry:
                raise version.error
            if version.pending is not None:
                if retry and version.pending.done():
                    version.pending = None
                else:
                    return version.pending
            if self.hot(identity) is not None:
                return None
            if self._closed and not version.pins:
                raise AnalysisReadError('Record result store is closed.')
            version.error = None
            if version.portable is not None:
                def work(lane):
                    reply = lane.codec(self.identity, self.schemas, 'read',
                                       data=version.read(), fields=version.fields)
                    self.cache.put(identity, reply['canonical'], reply['residentBytes'], reloadable=True)
                    return reply['canonical']
                version.pending = self.scheduler.submit_read(
                    (self.identity, identity), work, group=group, prefetch=prefetch)
            elif version.reservation is not None:
                if version.revision:
                    try:
                        self.writer.submit('accept_result', version.revision, slot=version.slot,
                                           epoch=version.epoch, version=version.identity)
                    except Exception as error:
                        version.persistence_error = error
                version.pending = self.scheduler.submit_required(
                    version.reservation, lambda lane: self._encode(version, lane), retry=True)
            else:
                # A legacy demanded read also converts exactly this result; no
                # all-record eager conversion or second decoded mirror.
                reservation = self.reserve(foreground=not prefetch)
                if reservation is None:
                    return None
                version.reservation = reservation
                version.pending = self.scheduler.submit_read(
                    (self.identity, identity), lambda lane: self._encode(version, lane),
                    group=group, prefetch=prefetch)
            self._observe_failure(version)
            return version.pending

    def clear(self, slots, *, revision):
        with self._lock:
            tombstones = []
            for slot in slots:
                old = self._slots.pop(slot, None)
                if old is not None:
                    self._orphans[old] = None
                epoch = self._epochs.get(slot, 0) + 1
                self._epochs[slot] = epoch
                tombstones.append((slot, epoch))
            self._clears[revision] = tombstones
        return self.retry_clear(revision)

    def collect_garbage(self, *, limit=128):
        """Bounded writer maintenance. Snapshot pins beat live-slot deletion."""
        retired = []
        with self._lock:
            for identity in tuple(self._orphans)[:limit]:
                version = self._versions[identity]
                if version.pins or version.pending is not None or version.durable is not None and not version.durable.done():
                    self._orphans.move_to_end(identity)
                    continue
                retired.append(version)
            if not retired:
                return None
            future = self.writer.submit('collect_versions', [version.identity for version in retired], body=True)
            for version in retired:
                self._orphans.pop(version.identity)
                self._versions.pop(version.identity)
                self.cache.discard(version.identity)
                if version.encoded is not None:
                    self._encoded_pending -= len(version.encoded)
                if version.reservation is not None:
                    version.reservation.release()
                if version.rescue_backing is not None:
                    version.rescue_backing.close()
        return future

    def retry_clear(self, revision):
        with self._lock:
            tombstones = self._clears[revision]
        try:
            future = self.writer.submit('clear_slots', revision, tombstones)
        except Exception as error:
            future = Future()
            future.set_exception(error)
        def finished(write):
            with self._lock:
                if write.exception() is None:
                    self._clears.pop(revision, None)
                    self._clear_failures.discard(revision)
                else:
                    self._clear_failures.add(revision)
        future.add_done_callback(finished)
        return future

    @contextmanager
    def capture(self, identities=None):
        """An export owns immutable versions, never a long SQL read transaction."""
        with self._lock:
            versions = [self._versions[key] for key in (
                list(self._slots.values()) if identities is None else identities)]
            for version in versions:
                version.pins += 1
        try:
            yield tuple(versions)
        finally:
            with self._lock:
                for version in versions:
                    version.pins -= 1

    def portable(self, version):
        """Finite captured-version barrier. Must not be called under game lock."""
        while True:
            with self._lock:
                pending, portable, error = version.pending, version.portable, version.error
            if error is not None:
                raise error
            if pending is not None:
                pending.result()
                with self._lock:
                    if version.pending is pending:
                        version.pending = None
                continue
            if portable is not None:
                return portable
            pending = self.request(version.identity)
            if pending is None:
                # Save waits off-lock for legacy capacity, never a busy loop or
                # gameplay-thread wait. Inference reservations still own their
                # accepted data; do not steal one to force an export forward.
                reservation = self.scheduler.reserve(foreground=True, block=True)
                with self._lock:
                    if version.pending is None and version.portable is None:
                        version.reservation = reservation
                        version.pending = self.scheduler.submit_required(
                            reservation, lambda lane: self._encode(version, lane))
                        self._observe_failure(version)
                    else:
                        reservation.release()

    def metrics(self):
        with self._lock:
            return {**self.cache.metrics(), 'encodedPendingBytes': self._encoded_pending,
                    'failedClears': len(self._clear_failures),
                    'versions': len(self._versions), 'orphanVersions': len(self._orphans),
                    **self.writer.metrics()}

    def close(self):
        with self._lock:
            self._closed = True
            for version in self._versions.values():
                if not version.pins and version.rescue_backing is not None:
                    version.rescue_backing.close()
