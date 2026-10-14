"""Record-session revisions, incremental authored packets and finite barriers.

Main supplies private workspace identity/lifetime. This owner never publishes a
renderer view or decides whether a portable file rename succeeded.
"""

import copy
from concurrent.futures import Future
from dataclasses import dataclass
import json
from threading import RLock, Timer
from uuid import uuid4

from .record_result_store import RecordResultStore


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


class RecordSessionStorage:
    def __init__(self, identity, scheduler, writer, *, results=None, coalesce_seconds=.25,
                 pending_limit=256):
        self.identity, self.writer = identity, writer
        self.session_id = uuid4().hex
        self.results = results or RecordResultStore(identity, scheduler, writer)
        self._lock = RLock()
        self.content_revision = self.cursor_sequence = 0
        self._generation = 0
        self._accepting = True
        self._pending_limit, self._delay = pending_limit, coalesce_seconds
        self._timer = None
        self._queued = {}
        self._obligations = {}
        self._failed = {}
        self._cursor_future = None

    @classmethod
    def restore(cls, identity, scheduler, writer, *, coalesce_seconds=.25):
        index = writer.ready.result().restore_index()
        results = RecordResultStore.restore(identity, scheduler, writer, index=index)
        session = cls(identity, scheduler, writer, results=results, coalesce_seconds=coalesce_seconds)
        session.content_revision = index['contentRevision']
        cursor = index['metadata'].get('cursor') or {'sequence': 0, 'state': {}}
        session.cursor_sequence = cursor['sequence']
        game = {key[5:]: value for key, value in index['metadata'].items() if key.startswith('game:')}
        game['nodes'] = {key: {**node['attributes'], 'snapshot': node['snapshot']}
                         for key, node in index['nodes'].items()}
        game['currentNodeId'] = cursor['state'].get('currentNodeId')
        if not game['nodes'] or game['currentNodeId'] not in game['nodes']:
            raise ValueError('Recovery has no valid current node.')
        game['pendingReview'] = None
        state = {key: value for key, value in cursor['state'].items() if key != 'currentNodeId'}
        return session, game, state

    def initialize(self, game, state):
        """One baseline from a private prepared candidate, outside gameplay lock."""
        nodes = {key: {'snapshot': copy.deepcopy(node['snapshot']), 'attributes': node_attributes(node)}
                 for key, node in game['nodes'].items()}
        metadata = {f'game:{key}': copy.deepcopy(value) for key, value in game.items()
                    if key not in ('nodes', 'currentNodeId', 'pendingReview')}
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
        self.move_cursor({'currentNodeId': game['currentNodeId'], **state})
        return baseline

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

    def flush_authored(self):
        with self._lock:
            timer, self._timer = self._timer, None
            batch, self._queued = self._queued, {}
        if timer is not None:
            timer.cancel()
        if not batch:
            return
        try:
            persisted = self.writer.submit('authored_batch', [(rev, row[0]) for rev, row in batch.items()])
        except Exception as error:
            with self._lock:
                self._failed.update(batch)
            for _packet, future in batch.values():
                future.set_exception(error)
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
        self.flush_authored()
        return tuple(futures)

    def move_cursor(self, state):
        with self._lock:
            self.cursor_sequence += 1
            try:
                self._cursor_future = self.writer.submit('cursor', self.cursor_sequence, copy.deepcopy(state))
            except Exception as error:
                self._cursor_future = Future()
                self._cursor_future.set_exception(error)
            return self.cursor_sequence

    def reserve_analysis(self, *, foreground=False):
        with self._lock:
            if not self._accepting:
                return None
            if self._failed:
                return None
            reservation = self.results.reserve(foreground=foreground)
            return AnalysisAdmission(self.session_id, self._generation, reservation) if reservation is not None else None

    def accept_analysis(self, reservation_context, slot, result, *, epoch, kind='opponent', seat=None):
        reservation = reservation_context.reservation
        with self._lock:
            if (not self._accepting or reservation_context.session != self.session_id
                    or reservation_context.generation != self._generation):
                reservation.release()
                return None
            version = self.results.accept(slot, result, revision=self.content_revision + 1, epoch=epoch,
                                          reservation=reservation, kind=kind, seat=seat)
            if version is not None:
                self.content_revision += 1
            return version

    def cutoff(self, *, freeze=False):
        with self._lock:
            if freeze:
                self._accepting = False
                self._generation += 1
            return RecordCutoff(self.session_id, self._generation, self.content_revision,
                                self.cursor_sequence, self._cursor_future, freeze)

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
        self.flush_authored()
        for future in pending:
            future.result()
        if cursor is not None:
            cursor.result()

    def stop(self):
        """Admission only; writer/resource release is a later owned lifecycle step."""
        with self._lock:
            self._accepting = False
        self.flush_authored()
