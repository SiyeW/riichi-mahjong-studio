"""Backend resource lifetime for main-allocated private record identities.

Main owns live claims/retention and filesystem promotion. This owner installs
prepared storage, acknowledges activation and releases retired resources only
after actual task/export pins and accepted codec jobs finish. No portable exit
snapshot or command replay lives here.
"""

from collections import OrderedDict
from concurrent.futures import Future
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import Condition, RLock, Thread, local
from uuid import UUID

from .record_session_storage import RecordSessionStorage
from .record_workspace_writer import RecordWorkspaceWriter


def workspace_identity(value):
    if not isinstance(value, str) or str(UUID(value)) != value:
        raise ValueError('Invalid private workspace identity.')
    return value


@dataclass
class RecordResource:
    storage: object
    game: dict
    state: dict
    activation: object = None
    disposition: str | None = None
    released: object = None
    operations: int = 0
    saved: dict | None = None
    initial_cursor: int = 0
    restored: bool = False


class RecordResourceManager:
    def __init__(self, root, scheduler, *, emit=lambda event: None):
        self.root = Path(root).resolve()
        self.scheduler, self.emit = scheduler, emit
        self._lock = RLock()
        self._condition = Condition(self._lock)
        self._local = local()
        self._resources = {}
        self._retired = OrderedDict()
        self._released = OrderedDict()
        self._active = None
        self._thread = None
        self._closed = False
        self._transport_error = None

    @contextmanager
    def candidate(self, identity, *, baseline=None):
        identity = workspace_identity(identity)
        previous = getattr(self._local, 'identity', None)
        previous_baseline = getattr(self._local, 'baseline', None)
        self._local.identity = identity
        self._local.baseline = baseline
        try:
            yield
        finally:
            self._local.identity = previous
            self._local.baseline = previous_baseline
            with self._lock:
                abandoned = self._resources.get(identity)
                if abandoned is not None and abandoned is not self._active and abandoned.activation is None:
                    self._retire(abandoned, 'retained' if abandoned.restored else 'discarded')

    def _path(self, identity):
        directory = self.root / workspace_identity(identity)
        self.root.mkdir(parents=True, exist_ok=True)
        directory.mkdir(exist_ok=True)
        if directory.resolve().parent != self.root:
            raise ValueError('Private workspace must remain inside its managed root.')
        return directory / 'workspace.sqlite'

    def create(self, game, state, *, origin=None):
        identity = getattr(self._local, 'identity', None)
        if identity is None:
            raise ValueError('Main must allocate a workspace before preparing a record.')
        with self._lock:
            if self._closed or identity in self._resources:
                raise ValueError('Private workspace is already owned or closing.')
        writer = RecordWorkspaceWriter(self._path(identity), identity, create=True)
        try:
            writer.ready.result()
            storage = RecordSessionStorage(identity, self.scheduler(), writer)
            resource = RecordResource(storage, game, dict(state), released=Future())
            with self._lock:
                self._resources[identity] = resource
            storage.initialize(game, state, origin=origin).result()
            resource.initial_cursor = storage.cursor_sequence
            baseline = getattr(self._local, 'baseline', None)
            if baseline is not None:
                self._set_baseline(resource, clean=bool(baseline.get('clean')),
                    target=baseline.get('target', ''),
                    file_identity=origin.source.identity if origin else None)
            return storage
        except Exception:
            with self._lock:
                self._resources.pop(identity, None)
            writer.close()
            raise

    def activate(self, storage, previous, previous_state):
        """Short metadata swap under the game lock; no durability wait here."""
        with self._lock:
            old = self._resources.get(previous.identity) if previous is not None else None
            if old is not None:
                old.state = {key: value for key, value in previous_state.items() if key not in ('game', 'gameLoaded')}
            if storage is None:
                self._active = None
                if old is not None:
                    self._retire(old, 'discarded')
                return
            resource = self._resources[storage.identity]
            self._active = resource
            resource.activation = storage.writer.submit('activate')
            # The old claim is not retired merely because a new in-memory view
            # exists. Main confirms replacement after its durable active marker.

    def restore(self, identity):
        identity = workspace_identity(identity)
        path = self.root / identity / 'workspace.sqlite'
        if path.parent.resolve().parent != self.root or not path.is_file():
            raise ValueError('Private recovery workspace is missing or outside its managed root.')
        with self._lock:
            if self._closed or identity in self._resources:
                raise ValueError('Private recovery is already owned or closing.')
        writer = RecordWorkspaceWriter(path, identity)
        try:
            workspace = writer.ready.result()
            metadata = workspace.metadata()
            if metadata.get('disposition') in ('discarded', 'replaced', 'retention-off', 'prepared'):
                raise ValueError('Private recovery was not retained as an active record.')
            storage, game, state = RecordSessionStorage.restore(identity, self.scheduler(), writer)
            resource = RecordResource(storage, game, dict(state), released=Future(),
                                      saved=metadata.get('saved'), initial_cursor=storage.cursor_sequence, restored=True)
            with self._lock:
                self._resources[identity] = resource
            return storage, game, state
        except Exception:
            writer.close()
            raise

    def confirm_activation(self, identity, previous=None):
        with self._lock:
            resource = self._resources[workspace_identity(identity)]
            if self._active is not resource:
                raise ValueError('Prepared record is no longer active.')
            activation = resource.activation
        activation.result()
        with self._lock:
            if self._active is not resource:
                raise ValueError('RMS_RECORD_SCOPE_CHANGED: The active record changed during activation.')
            if previous is not None:
                old = self._resources.get(workspace_identity(previous))
                if old is not None and old is not resource:
                    self._retire(old, 'replaced')
        return {'workspaceId': identity, 'session': resource.storage.session_id}

    def resource(self, identity, *, active=False):
        with self._lock:
            resource = self._resources[workspace_identity(identity)]
            if active and resource is not self._active:
                raise ValueError('RMS_RECORD_SCOPE_CHANGED: The active record changed.')
            return resource

    def hold(self, identity):
        with self._condition:
            resource = self.resource(identity, active=True)
            resource.operations += 1
            return resource

    def release(self, resource):
        with self._condition:
            if resource.operations <= 0:
                raise RuntimeError('Record operation has already released its owner.')
            resource.operations -= 1
            self._condition.notify_all()

    def set_baseline(self, identity, *, clean, target='', file_identity=None):
        resource = self.resource(identity, active=True)
        self._set_baseline(resource, clean=clean, target=target, file_identity=file_identity)

    def _set_baseline(self, resource, *, clean, target='', file_identity=None):
        content = 1 if clean else 0
        cursor = resource.initial_cursor if clean else 0
        resource.storage.writer.submit('saved_baseline', content, cursor, target, file_identity).result()
        with self._lock:
            resource.saved = dict(id=None, content=content, cursor=cursor, target=target, intent=0)
            if file_identity is not None:
                resource.saved['fileIdentity'] = file_identity

    def runtime(self):
        with self._lock:
            resource = self._active
            if resource is None:
                return None
            content, cursor = resource.storage.revisions()
            saved = resource.saved or {}
            return dict(workspaceId=resource.storage.identity, session=resource.storage.session_id,
                        contentRevision=content, cursorSequence=cursor,
                        savedContentRevision=saved.get('content', 0), savedCursorSequence=saved.get('cursor', 0),
                        pathIntent=saved.get('intent', 0), savedPath=saved.get('target', ''))

    def mark_saved(self, resource, token, file_identity=None):
        with self._lock:
            saved = resource.saved or {}
            if token['pathIntent'] >= saved.get('intent', 0):
                resource.saved = dict(id=token['saveId'], content=token['contentRevision'],
                    cursor=token['cursorSequence'], target=token['target'], intent=token['pathIntent'])
                if file_identity is not None:
                    resource.saved['fileIdentity'] = file_identity

    def retire(self, identity, disposition):
        with self._condition:
            resource = self.resource(identity, active=True)
            self._active = None
            self._retire(resource, disposition)

    def _retire(self, resource, disposition):
        resource.storage.stop()
        resource.disposition = disposition
        self._retired[resource.storage.identity] = resource
        if self._thread is None:
            self._thread = Thread(target=self._collect, name='record-resource-retirement', daemon=True)
            self._thread.start()
        self._condition.notify_all()

    def _collect(self):
        while True:
            with self._condition:
                while not self._retired and not self._closed:
                    self._condition.wait()
                if not self._retired:
                    return
                identity, resource = self._retired.popitem(last=False)
                while resource.operations:
                    self._condition.wait()
            try:
                resource.storage.writer.submit('retire', resource.disposition).result()
            except Exception as error:
                retirement_error = str(error)
            else:
                retirement_error = None
            resource.storage.results.wait_unused()
            resource.storage.results.dispose()
            try:
                resource.storage.writer.close()
            except Exception as error:
                retirement_error = retirement_error or str(error)
            if resource.storage.origin is not None:
                resource.storage.origin.source._close()
            outcome = dict(workspaceId=identity, disposition=resource.disposition, retirementError=retirement_error)
            with self._lock:
                self._resources.pop(identity, None)
                self._released[identity] = outcome
                while len(self._released) > 128:
                    self._released.popitem(last=False)
            resource.released.set_result(outcome)
            try:
                self.emit({'type': 'workspace_released', **outcome})
            except Exception as error:
                self._transport_error = str(error)  # Parent loss must not stop release of remaining resources.

    def wait_released(self, identity):
        with self._lock:
            resource = self._resources.get(workspace_identity(identity))
            outcome = self._released.get(identity)
        if resource is not None:
            return resource.released.result()
        return outcome

    def abandon(self, identity):
        with self._condition:
            resource = self._resources.get(workspace_identity(identity))
            if resource is self._active and resource is not None:
                raise ValueError('An activated record cannot be abandoned as a failed preparation.')
            if resource is not None and resource.disposition is None:
                self._retire(resource, 'retained' if resource.restored else 'discarded')
        return self.wait_released(identity) or dict(workspaceId=identity, disposition='discarded', retirementError=None)

    def shutdown(self):
        with self._condition:
            for resource in tuple(self._resources.values()):
                if resource.disposition is None:
                    self._retire(resource, 'retained')
            self._closed = True
            self._condition.notify_all()
        if self._thread is not None:
            self._thread.join()
