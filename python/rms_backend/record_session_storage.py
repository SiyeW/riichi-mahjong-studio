"""Record-session revisions, incremental authored packets and finite barriers.

Main supplies private workspace identity/lifetime. This owner never publishes a
renderer view or decides whether a portable file rename succeeded.
"""

import copy
from concurrent.futures import Future
from dataclasses import dataclass
import json
from pathlib import Path
from threading import Lock, RLock, Timer
from uuid import uuid4

from .record_result_store import RecordResultStore
from .analysis_cache import cache_key_context
from .analysis_cache_codec import EncodedJsonValue, JsonReference, raw_json_items
from .record_analysis_refs import AnalysisReference
from .record_blocks import BlockResult
from .analysis_body_codec import POLICY
from .record_archive import ArchiveAnalysis, PortableBody


@dataclass(frozen=True)
class RecordCutoff:
    session: str
    generation: int
    content: int
    cursor: int
    cursor_write: object = None
    closing: bool = False


@dataclass(frozen=True)
class AnalysisAdmission:
    session: str
    generation: int
    reservation: object


def node_attributes(node):
    return copy.deepcopy({key: value for key, value in node.items()
                          if key not in ('snapshot', 'analysisCache', 'opponentAnalysisCache')})


def result_slot(node_id, field, cache_key):
    return json.dumps([node_id, field, cache_key], ensure_ascii=False, separators=(',', ':'))


def result_fields(result):
    if isinstance(result, ArchiveAnalysis):
        return dict(result.entry['fields'])
    if isinstance(result, BlockResult) and result.pristine():
        return dict(result.entry.descriptor['fields'])
    fields = {}
    for key, value in raw_json_items(result):
        if isinstance(value, EncodedJsonValue):
            fields[key] = [False, None] if value.is_container else [True, value.resolve()]
        elif isinstance(value, JsonReference):
            fields[key] = [False, None]
        else:
            fields[key] = [False, None] if isinstance(value, (dict, list)) else [True, value]
    return fields


class RecordSessionStorage:
    def __init__(self, identity, scheduler, writer, *, results=None, coalesce_seconds=.25,
                 pending_limit=256):
        self.identity, self.writer = identity, writer
        self.session_id = uuid4().hex
        self.results = results or RecordResultStore(identity, scheduler, writer)
        self._lock = RLock()
        self._base_lock = Lock()
        self.content_revision = self.cursor_sequence = 0
        self._generation = 0
        self._accepting = True
        self._pending_limit, self._delay = pending_limit, coalesce_seconds
        self._timer = None
        self._queued = {}
        self._obligations = {}
        self._failed = {}
        self._cursor_future = None
        self._cursor_active = self._cursor_pending = None
        self._cursor_failed = None
        self._cursor_state = None
        self.origin = None
        self._origin_descriptor = None
        self._source_writes = []
        self._source_failures = {}
        self.source_error = None

    @classmethod
    def restore(cls, identity, scheduler, writer, *, coalesce_seconds=.25):
        index = writer.ready.result().restore_index()
        results = RecordResultStore.restore(identity, scheduler, writer, index=index)
        session = cls(identity, scheduler, writer, results=results, coalesce_seconds=coalesce_seconds)
        session.content_revision = index['contentRevision']
        cursor = index['metadata'].get('cursor') or {'sequence': 0, 'state': {}}
        session.cursor_sequence = cursor['sequence']
        session._cursor_state = copy.deepcopy(cursor['state'])
        game = {key[5:]: value for key, value in index['metadata'].items() if key.startswith('game:')}
        game['nodes'] = {key: {**node['attributes'], 'snapshot': node['snapshot']}
                         for key, node in index['nodes'].items()}
        game['currentNodeId'] = cursor['state'].get('currentNodeId')
        if not game['nodes'] or game['currentNodeId'] not in game['nodes']:
            raise ValueError('Recovery has no valid current node.')
        game['pendingReview'] = cursor['state'].get('pendingReview', game.get('pendingReview'))
        state = {key: value for key, value in cursor['state'].items() if key not in ('currentNodeId', 'pendingReview')}
        session._origin_descriptor = index['metadata'].get('origin')
        unbound = results.unbound_source_inputs()
        if unbound and session._origin_descriptor is not None:
            from .record_file import read_record_file, RecordOrigin
            from .analysis_cache_storage import expand_record_analysis_caches
            try:
                descriptor = session._origin_descriptor
                document = read_record_file(descriptor.get('base') or descriptor['path'])
                if document.origin.source.identity != {key: descriptor[key] for key in ('size', 'prefix')}:
                    raise ValueError('Recovery source identity mismatch.')
                if descriptor.get('base'):
                    document.origin.source.detached = True
                    document.origin.source.base_path = descriptor['base']
                session.origin = RecordOrigin(descriptor['path'], document.origin.format, document.origin.source)
                expand_record_analysis_caches(document, lazy=True)
                for identity, locator in unbound:
                    value = document['game']['nodes'][locator['node']][locator['field']][locator['key']]
                    if isinstance(value, EncodedJsonValue):
                        value = value.resolve()
                    results.bind_source_input(identity, value)
            except (OSError, ValueError, KeyError) as error:
                session.source_error = str(error)  # Keep authored/new durable facts, never fake an empty cache.
        session.adopt_analyses(game, source_game={'nodes': {}})
        return session, game, state

    def initialize(self, game, state, *, origin=None):
        """One baseline from a private prepared candidate, outside gameplay lock."""
        nodes = {key: {'snapshot': copy.deepcopy(node['snapshot']), 'attributes': node_attributes(node)}
                 for key, node in game['nodes'].items()}
        metadata = {f'game:{key}': copy.deepcopy(value) for key, value in game.items()
                    if key not in ('nodes', 'currentNodeId', 'pendingReview')}
        self.origin = origin
        self._origin_descriptor = origin.descriptor() if origin is not None else None
        if self._origin_descriptor is not None:
            metadata['origin'] = self._origin_descriptor
        with self._lock:
            if self.content_revision:
                raise ValueError('Record storage baseline already exists.')
            self.content_revision = 1
            packet = dict(nodes=nodes, metadata=metadata)
            baseline = self.writer.submit('authored_delta', 1, **packet)
            self._obligations[1] = baseline
        def completed(future):
            with self._lock:
                if future.exception() is None:
                    self._obligations.pop(1, None)
                else:
                    self._failed[1] = (packet, future)
            if future.exception() is None:
                packet.clear()
        baseline.add_done_callback(completed)
        self.move_cursor({'currentNodeId': game['currentNodeId'], 'pendingReview': copy.deepcopy(game.get('pendingReview')), **state})
        return baseline

    def adopt_analyses(self, game, *, source_game=None):
        """Replace node values with store handles, without reading saved bodies.

        Restore may merge the identified source's untouched legacy entries with
        newer private versions. A durable tombstone always beats the source.
        """
        origin = game if source_game is None else source_game
        source_entries, source_bodies, input_identities = [], {}, []
        for node_id, node in game['nodes'].items():
            source_node = origin.get('nodes', {}).get(node_id) or {}
            for field in ('analysisCache', 'opponentAnalysisCache'):
                source_cache = source_node.get(field)
                if not isinstance(source_cache, dict):
                    continue
                mapped = {}
                for cache_key, result in raw_json_items(source_cache):
                    slot = result_slot(node_id, field, cache_key)
                    identity = self.results.slot(slot)
                    if identity is None and self.results.has_slot(slot):
                        continue
                    if identity is None:
                        if isinstance(result, EncodedJsonValue):
                            result = result.resolve()  # Root-object header only, not its arrays.
                        if not isinstance(result, dict):
                            raise ValueError('Saved analysis result is not an object.')
                        context = cache_key_context(cache_key) or {}
                        fields = result_fields(result)
                        kind = 'decision' if field == 'analysisCache' else 'opponent'
                        summary = {'fields': fields, 'kind': kind, 'seat': context.get('seat')}
                        body, read, portable, codec = None, None, None, 'input'
                        raw = result
                        if isinstance(result, ArchiveAnalysis):
                            schemas = result.archive.schemas
                            common = min(len(schemas), len(self.results.schemas))
                            if schemas[:common] != self.results.schemas[:common]:
                                raise ValueError('Imported schemas conflict with the record namespace.')
                            self.results.schemas.extend(schemas[len(self.results.schemas):])
                            source, body_index = result.archive.source, result.entry['body']
                            descriptor = source.descriptors[body_index]
                            portable = PortableBody.from_source(source, body_index)
                            read = lambda source=source, index=body_index: source.read_body(index)
                            codec, raw = POLICY, None
                            body = {'codec': codec, 'length': descriptor.length, 'digest': descriptor.digest,
                                    'base': str(Path(source.file.name).resolve()), 'offset': source.start + descriptor.offset}
                        elif isinstance(result, BlockResult) and result.pristine():
                            source, descriptor = result.entry.source, result.entry.descriptor
                            codec = 'packed-json-v1'
                            body = {'codec': codec, 'length': descriptor['length'], 'digest': bytes.fromhex(descriptor['sha256']),
                                    'base': str(Path(source.file.name).resolve()), 'offset': source.start + descriptor['offset']}
                        elif self._origin_descriptor is not None:
                            summary['source'] = {'node': node_id, 'field': field, 'key': cache_key}
                        else:
                            summary['input'] = True
                            codec = 'json-input-v1'
                        if body is not None:
                            fingerprint = (body['base'], body['offset'], body['length'], body['digest'])
                            body['id'] = source_bodies.setdefault(fingerprint, uuid4().hex)
                            body['namespace'] = self.identity
                        identity = self.results.register(slot, fields=fields, raw=raw, kind=kind,
                            seat=context.get('seat'), read=read, portable=portable,
                            body_id=body['id'] if body is not None else None, source_codec=codec,
                            source_locator=summary.get('source'),
                            source_span=(body['base'], body['offset'], body['length'], body['digest']) if body is not None else None)
                        source_entries.append({'version': identity, 'slot': slot, 'epoch': 0,
                                               'body': body, 'summary': summary})
                        if summary.get('input'):
                            source_entries[-1]['input'] = result
                            input_identities.append(identity)
                    elif source_game is not None:
                        if isinstance(result, EncodedJsonValue):
                            result = result.resolve()
                        self.results.bind_source_input(identity, result)
                    mapped[cache_key] = AnalysisReference(self.results, identity)
                node[field] = mapped
        if source_entries:
            self._write_sources(source_entries, list(enumerate(self.results.schemas)), input_identities)
        for slot, identity in self.results.live_slots():
            node_id, field, cache_key = json.loads(slot)
            if field not in ('analysisCache', 'opponentAnalysisCache'):
                raise ValueError('Recovery contains an unknown analysis slot kind.')
            node = game['nodes'].get(node_id)
            if node is not None:
                node.setdefault(field, {})[cache_key] = AnalysisReference(self.results, identity)

    def _write_sources(self, entries, schemas, inputs):
        owned = Future()
        owned.set_running_or_notify_cancel()
        try:
            write = self.writer.submit('adopt_sources', entries, schemas=schemas)
        except Exception as error:
            write = Future()
            write.set_exception(error)
        self._source_writes.append(owned)
        def completed(persisted):
            error = persisted.exception()
            if error is None:
                self.results.adopt_inputs(inputs)
                entries.clear()
                owned.set_result(None)
            else:
                with self._lock:
                    self._source_failures[owned] = (entries, schemas, inputs)
                owned.set_exception(OSError(str(error)))
        write.add_done_callback(completed)
        return owned

    def retry_sources(self):
        with self._lock:
            failed = tuple(self._source_failures.items())
            self._source_failures.clear()
            self._source_writes = [write for write in self._source_writes if write not in dict(failed)]
        return tuple(self._write_sources(*packet) for _write, packet in failed)

    @property
    def origin_descriptor(self):
        return dict(self._origin_descriptor) if self._origin_descriptor is not None else None

    def ensure_private_base(self, *, strict=True):
        """Off-lock, once, only when retention/overwrite needs external bytes."""
        with self._base_lock:
            descriptor = self._origin_descriptor
            if descriptor is None or descriptor.get('base'):
                return None
            dependencies = self.results.source_dependencies(descriptor['path'])
            if not dependencies:
                if self.origin is not None:
                    self.origin.source._close()
                return None
            if self.origin is None:
                from .record_file import read_record_file
                loaded = read_record_file(descriptor['path'])
                if loaded.origin.source.identity != {key: descriptor[key] for key in ('size', 'prefix')}:
                    loaded.origin.source._close()
                    raise ValueError('Original record changed before recovery base setup.')
                self.origin = loaded.origin
            source = self.origin.source
            required = set()
            spans = {(source.start + item.offset, item.length, item.digest): index
                     for index, item in enumerate(source.descriptors)}
            for version in dependencies:
                if version.source_span is not None:
                    _, offset, length, digest = version.source_span
                    required.add(spans[(offset, length, digest)])
            base = Path(self.writer.path).parent / 'source.mjstudio'
            source.detach(str(base), required_indices=required)
            updated = {**descriptor, 'base': str(base.resolve())}
            # RAM readers may use the complete copy even if local bookkeeping
            # fails. Recovery remains explicitly degraded until its retry.
            self.results.adopt_base(descriptor['path'], updated['base'])
            try:
                self.writer.submit('adopt_base', descriptor['path'], updated['base'], updated).result()
            except Exception as error:
                self.source_error = str(error)
                if strict:
                    raise
                return updated['base']
            self._origin_descriptor = updated
            self.source_error = None
            return updated['base']

    def check_authored_admission(self):
        with self._lock:
            if not self._accepting:
                raise RuntimeError('Record changes are frozen for close.')
            if len(self._obligations) >= self._pending_limit:
                raise RuntimeError('Record persistence is behind; pending edits must be retained before accepting more.')

    def accept_authored(self, **packet):
        """Caller supplies detached changed rows/attributes, not the whole tree."""
        with self._lock:
            self.check_authored_admission()
            self.content_revision += 1
            revision = self.content_revision
            future = Future()
            future.set_running_or_notify_cancel()
            self._obligations[revision] = future
            self._queued[revision] = (packet, future)
            # Deadline from FIRST unflushed change, never reset by more typing.
            if self._timer is None:
                self._timer = Timer(self._delay, self.flush_authored)
                self._timer.daemon = True
                self._timer.start()
            return revision, future

    def flush_authored(self, *, retry=False):
        with self._lock:
            timer, self._timer = self._timer, None
            batch, self._queued = self._queued, {}
            if batch:
                try:
                    persisted = self.writer.submit('authored_retry' if retry else 'authored_batch',
                                                   [(rev, batch[rev][0]) for rev in sorted(batch)])
                except Exception as error:
                    self._failed.update(batch)
                    persisted = Future()
                    persisted.set_exception(error)
        if timer is not None:
            timer.cancel()
        if not batch:
            return
        def finished(write):
            error = write.exception()
            with self._lock:
                if error is None:
                    for revision in batch:
                        self._obligations.pop(revision, None)
                else:
                    self._failed.update(batch)
            for _packet, future in batch.values():
                if error is None:
                    future.set_result(None)
                else:
                    future.set_exception(error)
            batch.clear()
        persisted.add_done_callback(finished)

    def retry_authored(self):
        """Explicit off-lock retry; committed uncertain receipts are not replayed."""
        self.writer.submit('revision_coverage', []).result()  # Drain earlier admitted batch callbacks first.
        with self._lock:
            failed = dict(self._failed)
        coverage = self.writer.submit('revision_coverage', list(failed)).result()
        futures = []
        with self._lock:
            for revision, (packet, previous) in failed.items():
                if self._failed.get(revision, (None, None))[1] is not previous:
                    continue
                self._failed.pop(revision)
                future = Future()
                future.set_running_or_notify_cancel()
                futures.append(future)
                if coverage.get(revision) == ('authored', True):
                    self._obligations.pop(revision, None)
                    future.set_result(None)
                elif revision in coverage:
                    raise ValueError('Authored retry revision belongs to another operation.')
                else:
                    self._obligations[revision] = future
                    self._queued[revision] = (packet, future)
        self.flush_authored(retry=True)
        return tuple(futures)

    def move_cursor(self, state):
        with self._lock:
            if state == self._cursor_state:
                return self.cursor_sequence
            # A bookmark must not overtake the authored rows it references.
            # Only queue ownership is transferred here, never filesystem I/O.
            self.flush_authored()
            self._cursor_state = copy.deepcopy(state)
            self.cursor_sequence += 1
            if self._cursor_pending is None:
                future = Future()
                future.set_running_or_notify_cancel()
            else:
                future = self._cursor_pending[2]
            self._cursor_pending = (self.cursor_sequence, copy.deepcopy(state), future)
            self._cursor_failed = None
            self._cursor_future = future
            self._start_cursor_write()
            return self.cursor_sequence

    def _start_cursor_write(self):
        if self._cursor_active is not None or self._cursor_pending is None:
            return
        batch, self._cursor_pending = self._cursor_pending, None
        self._cursor_active = batch
        try:
            write = self.writer.submit('cursor', batch[0], batch[1])
        except Exception as error:
            write = Future()
            write.set_exception(error)
        def completed(persisted):
            error = persisted.exception()
            with self._lock:
                self._cursor_active = None
                if error is not None and batch[0] == self.cursor_sequence:
                    self._cursor_failed = batch[:2]
                self._start_cursor_write()
            if error is None:
                batch[2].set_result(None)
            else:
                batch[2].set_exception(error)
        write.add_done_callback(completed)

    def retry_cursor(self):
        with self._lock:
            if self._cursor_failed is None:
                return self._cursor_future
            sequence, state = self._cursor_failed
            self._cursor_failed = None
            future = Future()
            future.set_running_or_notify_cancel()
            self._cursor_pending = (sequence, state, future)
            self._cursor_future = future
            self._start_cursor_write()
            return future

    def reserve_analysis(self, *, foreground=False):
        with self._lock:
            if not self._accepting:
                return None
            if self._failed or self._source_failures:
                return None
            reservation = self.results.reserve(foreground=foreground)
            return AnalysisAdmission(self.session_id, self._generation, reservation) if reservation is not None else None

    def accept_analysis(self, reservation_context, slot, result, *, epoch, kind='opponent', seat=None,
                        superseded=(), metadata=None):
        reservation = reservation_context.reservation
        with self._lock:
            if (not self._accepting or reservation_context.session != self.session_id
                    or reservation_context.generation != self._generation):
                reservation.release()
                return None
            try:
                node_id, field, cache_key = json.loads(slot)
                if (not isinstance(node_id, str) or not node_id or field not in ('analysisCache', 'opponentAnalysisCache')
                        or not isinstance(cache_key, str) or not cache_key):
                    raise ValueError('Invalid record analysis address.')
            except (ValueError, TypeError):
                reservation.release()
                raise ValueError('Invalid record analysis address.') from None
            version = self.results.accept(slot, result, revision=self.content_revision + 1, epoch=epoch,
                                          reservation=reservation, kind=kind, seat=seat,
                                          superseded=superseded, metadata=metadata)
            if version is not None:
                self.content_revision += 1
            return version

    def clear_analysis(self, slots):
        with self._lock:
            self.check_authored_admission()
            self.content_revision += 1
            revision = self.content_revision
            future = self.results.clear(slots, revision=revision)
            self._own_urgent(revision, future)
            return revision, future

    def _own_urgent(self, revision, future):
        self._obligations[revision] = future
        def finished(write):
            with self._lock:
                if write.exception() is None and self._obligations.get(revision) is write:
                    self._obligations.pop(revision, None)
        future.add_done_callback(finished)

    def retry_clear_analysis(self, revision):
        future = self.results.retry_clear(revision)
        with self._lock:
            self._own_urgent(revision, future)
        return future

    def cutoff(self, *, freeze=False):
        with self._lock:
            if freeze:
                self._accepting = False
                self._generation += 1
            # Queue the exact finite bookmark now, before later cursor writes.
            # A shared coalesced future could otherwise wait for a later edit or
            # failed node that did not belong to this save/close cutoff.
            self.flush_authored()
            try:
                cursor_write = self.writer.submit('cursor', self.cursor_sequence, copy.deepcopy(self._cursor_state or {}))
            except Exception as error:
                cursor_write = Future()
                cursor_write.set_exception(error)
            return RecordCutoff(self.session_id, self._generation, self.content_revision,
                                self.cursor_sequence, cursor_write, freeze)

    def cancel_close(self, cutoff):
        with self._lock:
            if not cutoff.closing or cutoff.session != self.session_id or cutoff.generation != self._generation:
                return False
            self._generation += 1
            self._accepting = True
            return True

    def wait_authored(self, cutoff):
        """Finite accepted set, outside game lock. Newer edits remain independent."""
        if cutoff.session != self.session_id:
            raise ValueError('Record cutoff belongs to another session.')
        with self._lock:
            pending = [future for revision, future in self._obligations.items() if revision <= cutoff.content]
            cursor = cutoff.cursor_write
            sources = tuple(self._source_writes)
        self.flush_authored()
        for future in pending:
            future.result()
        if cursor is not None:
            cursor.result()
        for source in sources:
            source.result()

    def stop(self):
        """Admission only; writer/resource release is a later owned lifecycle step."""
        with self._lock:
            self._accepting = False
        self.flush_authored()
