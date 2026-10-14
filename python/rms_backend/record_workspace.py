"""Private transactional recovery backing, owned by one storage writer thread.

This is not the portable format. Authored deltas, cursor state and immutable
analysis bodies have separate update/coverage rules; metadata restore never
selects prediction BLOBs. Main/session lifecycle supplies the workspace lease.
"""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import sqlite3
from threading import get_ident

from .record_binary import DIRECTORY_LIMIT, RESULT_LIMIT, json_bytes, load_json

WORKSPACE_VERSION = 1
SCHEMA = """
CREATE TABLE metadata (key TEXT PRIMARY KEY, value BLOB NOT NULL);
CREATE TABLE nodes (id TEXT PRIMARY KEY, snapshot BLOB NOT NULL, attributes BLOB NOT NULL);
CREATE TABLE rounds (id TEXT PRIMARY KEY, value BLOB NOT NULL);
CREATE TABLE schemas (id INTEGER PRIMARY KEY, value BLOB NOT NULL);
CREATE TABLE bodies (
  id TEXT PRIMARY KEY, codec TEXT NOT NULL, namespace TEXT NOT NULL,
  length INTEGER NOT NULL CHECK(length > 0),
  digest BLOB NOT NULL CHECK(length(digest) = 32),
  data BLOB, base TEXT, offset INTEGER,
  CHECK((data IS NOT NULL AND base IS NULL AND offset IS NULL) OR
        (data IS NULL AND base IS NOT NULL AND offset >= 0))
);
CREATE TABLE versions (
  id TEXT PRIMARY KEY, slot TEXT NOT NULL, revision INTEGER NOT NULL,
  body TEXT REFERENCES bodies(id), summary BLOB NOT NULL
);
CREATE TABLE slots (
  slot TEXT PRIMARY KEY, version TEXT REFERENCES versions(id),
  epoch INTEGER NOT NULL, revision INTEGER NOT NULL
);
CREATE TABLE coverage (revision INTEGER PRIMARY KEY, kind TEXT NOT NULL, complete INTEGER NOT NULL);
CREATE TABLE saves (id TEXT PRIMARY KEY, content INTEGER NOT NULL, cursor INTEGER NOT NULL,
                    target TEXT NOT NULL, committed INTEGER NOT NULL DEFAULT 0);
"""


def _json(value):
    return load_json(value, limit=DIRECTORY_LIMIT)


class RecordWorkspace:
    """One writer connection; read methods use short independent connections."""

    def __init__(self, path, *, workspace_id, create=False):
        self.path = Path(path)
        self.workspace_id = workspace_id
        self._owner = get_ident()
        if sqlite3.sqlite_version_info < (3, 51, 3):
            raise RuntimeError('Record recovery requires SQLite 3.51.3 or newer.')
        if create:
            descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
            os.close(descriptor)
        # mode=rw prevents a failed restore accidentally creating an empty DB.
        uri = self.path.resolve().as_uri() + '?mode=rw'
        self._db = sqlite3.connect(uri, uri=True, isolation_level=None, timeout=1)
        self._closed = False
        try:
            if not create:
                row = self._db.execute("SELECT value FROM metadata WHERE key='identity'").fetchone()
                if row is None or _json(row[0]) != {'id': workspace_id, 'version': WORKSPACE_VERSION}:
                    raise ValueError('Recovery workspace identity/version mismatch.')
            self._db.execute('PRAGMA foreign_keys=ON')
            self._db.execute('PRAGMA journal_mode=WAL')
            self._db.execute('PRAGMA synchronous=FULL')
            self._db.execute('PRAGMA wal_autocheckpoint=0')
            self._db.execute('PRAGMA cache_size=-2048')
            if create:
                # Exclusive creation belongs to main's UUID/lease lifecycle. Do
                # not treat an existing database as a fresh empty workspace.
                if self._db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchone():
                    raise ValueError('Recovery workspace already contains data.')
                self._db.executescript('BEGIN IMMEDIATE;\n' + SCHEMA + '\nCOMMIT;')
                with self.transaction():
                    self._set('identity', {'id': workspace_id, 'version': WORKSPACE_VERSION})
                    self._set('disposition', 'active')
                    self._set('cursor', {'sequence': 0, 'state': {}})
            identity = self.metadata().get('identity')
            if identity != {'id': workspace_id, 'version': WORKSPACE_VERSION}:
                raise ValueError('Recovery workspace identity/version mismatch.')
        except Exception:
            self._db.close()
            self._closed = True
            raise

    def _check_owner(self):
        if self._closed or get_ident() != self._owner:
            raise RuntimeError('Recovery writes require the live storage owner.')

    @contextmanager
    def transaction(self):
        self._check_owner()
        self._db.execute('BEGIN IMMEDIATE')
        try:
            yield
            self._db.execute('COMMIT')
        except BaseException:
            self._db.execute('ROLLBACK')
            raise

    def _set(self, key, value):
        self._db.execute('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                         (key, json_bytes(value)))

    def _coverage(self, revision, kind, complete):
        if type(revision) is not int or revision <= 0:
            raise ValueError('Invalid content revision.')
        old = self._db.execute('SELECT kind,complete FROM coverage WHERE revision=?', (revision,)).fetchone()
        if old is not None and (old[0] != kind or old[1] and not complete):
            raise ValueError('Content revision coverage conflict.')
        self._db.execute('INSERT INTO coverage VALUES(?,?,?) ON CONFLICT(revision) DO UPDATE SET complete=excluded.complete',
                         (revision, kind, int(complete)))

    def _new_revision(self, revision):
        if type(revision) is not int or revision <= 0:
            raise ValueError('Invalid content revision.')
        if self._db.execute('SELECT 1 FROM coverage WHERE revision=?', (revision,)).fetchone():
            raise ValueError('Content revision has already been accepted.')

    def authored_delta(self, revision, *, nodes=None, deleted=(), attributes=None,
                       metadata=None, rounds=None, deleted_rounds=()):
        """Update only supplied rows/attributes; comments need no snapshot write."""
        self.authored_batch([(revision, dict(nodes=nodes, deleted=deleted, attributes=attributes,
                                             metadata=metadata, rounds=rounds, deleted_rounds=deleted_rounds))])

    def authored_batch(self, changes):
        """One FULL transaction for a finite admitted batch, not command replay."""
        with self.transaction():
            for revision, packet in changes:
                self._authored_update(revision, **packet)

    def _authored_update(self, revision, *, nodes=None, deleted=(), attributes=None,
                         metadata=None, rounds=None, deleted_rounds=()):
        self._new_revision(revision)
        for node_id, node in (nodes or {}).items():
            self._db.execute('INSERT INTO nodes VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot, attributes=excluded.attributes',
                             (node_id, json_bytes(node['snapshot']), json_bytes(node['attributes'])))
        for node_id, value in (attributes or {}).items():
            if self._db.execute('UPDATE nodes SET attributes=? WHERE id=?', (json_bytes(value), node_id)).rowcount != 1:
                raise ValueError('Authored delta references a missing node.')
        for node_id in deleted:
            self._db.execute('DELETE FROM nodes WHERE id=?', (node_id,))
        for key, value in (metadata or {}).items():
            if key in ('identity', 'disposition', 'cursor', 'saved'):
                raise ValueError('Reserved recovery metadata key.')
            self._set(key, value)
        for round_id, value in (rounds or {}).items():
            self._db.execute('INSERT INTO rounds VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
                             (round_id, json_bytes(value)))
        for round_id in deleted_rounds:
            self._db.execute('DELETE FROM rounds WHERE id=?', (round_id,))
        self._coverage(revision, 'authored', True)

    def cursor(self, sequence, state):
        if type(sequence) is not int or sequence < 0:
            raise ValueError('Invalid cursor sequence.')
        with self.transaction():
            old = self._db.execute("SELECT value FROM metadata WHERE key='cursor'").fetchone()
            current = _json(old[0]) if old else None
            if current is not None and current['sequence'] == sequence and current['state'] != state:
                raise ValueError('Cursor sequence identity conflict.')
            if current is None or current['sequence'] < sequence:
                self._set('cursor', {'sequence': sequence, 'state': state})

    def accept_result(self, revision, *, slot, epoch, version, summary=None):
        """Persist the obligation, not a false claim that RAM-only data survived."""
        with self.transaction():
            previous = self._db.execute('SELECT slot,revision FROM versions WHERE id=?', (version,)).fetchone()
            if previous is not None:
                if previous != (slot, revision):
                    raise ValueError('Accepted result version identity conflict.')
                return  # Retry must not republish a subsequently cleared slot.
            self._new_revision(revision)
            self._db.execute('INSERT INTO versions VALUES(?,?,?,NULL,?)',
                             (version, slot, revision, json_bytes(summary or {})))
            current = self._db.execute('SELECT epoch,revision FROM slots WHERE slot=?', (slot,)).fetchone()
            if current is None or current[0] == epoch and current[1] < revision:
                self._db.execute('INSERT INTO slots VALUES(?,?,?,?) ON CONFLICT(slot) DO UPDATE SET version=excluded.version,epoch=excluded.epoch,revision=excluded.revision',
                                 (slot, version, epoch, revision))
            self._coverage(revision, 'analysis', False)

    def cache_body(self, body_id, *, codec, namespace, data, schemas=()):
        """Read-only legacy conversion backing does not create dirty content."""
        if not isinstance(data, bytes) or not 0 < len(data) <= RESULT_LIMIT + 65536:
            raise ValueError('Invalid encoded cache body.')
        digest = hashlib.sha256(data).digest()
        with self.transaction():
            self._schemas(schemas)
            self._body(body_id, codec, namespace, len(data), digest, data, None, None)

    def _schemas(self, schemas):
        for index, schema in schemas:
            encoded = json_bytes(schema)
            old = self._db.execute('SELECT value FROM schemas WHERE id=?', (index,)).fetchone()
            if old is not None and old[0] != encoded:
                raise ValueError('Recovery schema identity conflict.')
            self._db.execute('INSERT OR IGNORE INTO schemas VALUES(?,?)', (index, encoded))

    def _body(self, body_id, codec, namespace, length, digest, data, base, offset):
        old = self._db.execute('SELECT codec,namespace,length,digest,data,base,offset FROM bodies WHERE id=?',
                               (body_id,)).fetchone()
        if old is not None:
            if old[:4] != (codec, namespace, length, digest) or data is not None and old[4] is not None and old[4] != data:
                raise ValueError('Recovery body fingerprint collision.')
            # A base-span hit requires byte comparison by the source owner
            # before this method; fingerprints alone are not equivalence.
        else:
            self._db.execute('INSERT INTO bodies VALUES(?,?,?,?,?,?,?,?)',
                             (body_id, codec, namespace, length, digest, data, base, offset))

    def store_result(self, version, *, body_id, codec, namespace=None, data=None, base=None,
                     offset=None, length=None, digest=None, schemas=(), summary=None):
        """Body/schema/version commit atomically; never republish a cleared slot."""
        if data is not None:
            if len(data) > RESULT_LIMIT + 65536:
                raise ValueError('Encoded recovery body exceeds its size limit.')
            length, digest = len(data), hashlib.sha256(data).digest()
        namespace = self.workspace_id if namespace is None else namespace
        if (type(length) is not int or length <= 0 or not isinstance(digest, bytes) or len(digest) != 32
                or not isinstance(body_id, str) or not body_id or len(body_id) > 256
                or not isinstance(namespace, str) or not namespace):
            raise ValueError('Invalid recovery body descriptor.')
        with self.transaction():
            pending = self._db.execute('SELECT revision,body FROM versions WHERE id=?', (version,)).fetchone()
            if pending is None:
                raise ValueError('Unknown accepted result version.')
            self._schemas(schemas)
            self._body(body_id, codec, namespace, length, digest, data, base, offset)
            if pending[1] is not None and pending[1] != body_id:
                raise ValueError('Immutable recovery version replacement.')
            self._db.execute('UPDATE versions SET body=? WHERE id=?', (body_id, version))
            if summary is not None:
                self._db.execute('UPDATE versions SET summary=? WHERE id=?', (json_bytes(summary), version))
            self._coverage(pending[0], 'analysis', True)

    def clear_slots(self, revision, slots):
        with self.transaction():
            self._new_revision(revision)
            for slot, epoch in slots:
                self._db.execute('INSERT INTO slots VALUES(?,NULL,?,?) ON CONFLICT(slot) DO UPDATE SET version=NULL,epoch=excluded.epoch,revision=excluded.revision',
                                 (slot, epoch, revision))
            self._coverage(revision, 'clear', True)

    def save_intent(self, save_id, content, cursor, target):
        with self.transaction():
            row = (content, cursor, str(target))
            existing = self._db.execute('SELECT content,cursor,target FROM saves WHERE id=?', (save_id,)).fetchone()
            if existing is not None and existing != row:
                raise ValueError('Save identity conflict.')
            self._db.execute('INSERT OR IGNORE INTO saves(id,content,cursor,target) VALUES(?,?,?,?)', (save_id, *row))

    def save_committed(self, save_id, content, cursor):
        """Idempotent host-rename ACK; must not apply captured browser state."""
        with self.transaction():
            row = self._db.execute('SELECT content,cursor,target FROM saves WHERE id=?', (save_id,)).fetchone()
            if row is None or row[:2] != (content, cursor):
                raise ValueError('Save acknowledgement identity mismatch.')
            self._db.execute('UPDATE saves SET committed=1 WHERE id=?', (save_id,))
            sequence = self._db.execute('SELECT rowid FROM saves WHERE id=?', (save_id,)).fetchone()[0]
            previous = self._db.execute("SELECT value FROM metadata WHERE key='saved'").fetchone()
            if previous is None or _json(previous[0])['sequence'] <= sequence:
                self._set('saved', {'id': save_id, 'content': content, 'cursor': cursor,
                                    'target': row[2], 'sequence': sequence})

    def retire(self, disposition):
        if disposition not in ('discarded', 'replaced', 'retention-off', 'retained'):
            raise ValueError('Invalid workspace disposition.')
        with self.transaction():
            self._set('disposition', disposition)

    @contextmanager
    def reader(self):
        if self._closed:
            raise RuntimeError('Recovery workspace is closed.')
        db = sqlite3.connect(self.path.resolve().as_uri() + '?mode=ro', uri=True, timeout=1)
        try:
            db.execute('PRAGMA query_only=ON')
            db.execute('PRAGMA cache_size=-512')
            yield db
        finally:
            db.close()

    def metadata(self):
        with self.reader() as db:
            return {key: _json(value) for key, value in db.execute('SELECT key,value FROM metadata')}

    def restore_index(self):
        with self.reader() as db:
            return {
                'metadata': {key: _json(value) for key, value in db.execute('SELECT key,value FROM metadata')},
                'contentRevision': db.execute('SELECT COALESCE(MAX(revision),0) FROM coverage').fetchone()[0],
                'nodes': {node_id: {'snapshot': _json(snapshot), 'attributes': _json(attributes)}
                          for node_id, snapshot, attributes in db.execute('SELECT id,snapshot,attributes FROM nodes')},
                'rounds': {key: _json(value) for key, value in db.execute('SELECT id,value FROM rounds')},
                'schemas': {key: _json(value) for key, value in db.execute('SELECT id,value FROM schemas')},
                'slots': list(db.execute('SELECT s.slot,s.epoch,s.revision,v.id,v.body FROM slots s LEFT JOIN versions v ON s.version=v.id')),
                'versionMetadata': {identity: _json(summary) for identity, summary in db.execute('SELECT id,summary FROM versions')},
                'bodies': list(db.execute('SELECT id,codec,length,digest,base,offset,namespace FROM bodies')),
                'pending': list(db.execute('SELECT revision,kind FROM coverage WHERE complete=0')),
                'saves': list(db.execute('SELECT id,content,cursor,target,committed FROM saves')),
            }

    def read_body(self, body_id):
        with self.reader() as db:
            # Exactly one requested BLOB; release SQL read before decode/export.
            row = db.execute('SELECT CASE WHEN length(data)<=? THEN data END,length,digest FROM bodies WHERE id=?',
                             (RESULT_LIMIT + 65536, body_id)).fetchone()
        if row is None or row[0] is None:
            raise ValueError('Recovery body needs its immutable base source.')
        data, length, digest = row
        if len(data) != length or hashlib.sha256(data).digest() != digest:
            raise ValueError('Damaged recovery analysis body.')
        return data

    def missing_coverage(self, through):
        with self.reader() as db:
            return [row[0] for row in db.execute('SELECT revision FROM coverage WHERE revision<=? AND complete=0', (through,))]

    def revision_coverage(self, revisions):
        if not revisions:
            return {}
        if len(revisions) > 256 or any(type(revision) is not int or revision <= 0 for revision in revisions):
            raise ValueError('Invalid revision coverage request.')
        placeholders = ','.join('?' for _ in revisions)
        with self.reader() as db:
            return {revision: (kind, bool(complete)) for revision, kind, complete in db.execute(
                f'SELECT revision,kind,complete FROM coverage WHERE revision IN ({placeholders})', revisions)}

    def maintain(self):
        self._check_owner()
        # PASSIVE can perform real I/O. The scheduler must bound admitted dirty
        # work before this call, not infer a time budget from its nonblocking mode.
        busy, frames, checkpointed = self._db.execute('PRAGMA wal_checkpoint(PASSIVE)').fetchone()
        wal = Path(str(self.path) + '-wal')
        return {'busy': busy, 'frames': frames, 'checkpointed': checkpointed,
                'pendingFrames': max(0, frames - checkpointed),
                'allocatedBytes': wal.stat().st_size if wal.exists() else 0}

    def close(self):
        if self._closed:
            return
        self._check_owner()
        self._db.close()
        self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
