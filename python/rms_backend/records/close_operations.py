"""Finite close tickets: freeze admission, retain facts, then confirm retirement.

Main persists the returned recovery descriptor before confirming. Cancellation
reopens admission immediately, even while the previous finite barrier is waiting.
Imported cold results are already backed and must not be converted just to exit.
"""

import copy
from dataclasses import dataclass
from threading import RLock

from .resources import workspace_identity


@dataclass
class CloseOperation:
    resource: object
    cutoff: object
    pins: object
    versions: tuple
    bookmark: dict
    retain: bool
    running: bool = False
    cancelled: bool = False
    result: dict | None = None


class RecordCloseOperations:
    def __init__(self, resources, session):
        self.resources, self.session = resources, session
        self._lock = RLock()
        self._operations = {}

    def capture(self, identity, close_id, *, retain):
        """Called with the game lock held; no filesystem/codec waits."""
        close_id = workspace_identity(close_id)
        with self._lock:
            if close_id in self._operations:
                operation = self._operations[close_id]
                if operation.resource.storage.identity != identity or operation.retain != bool(retain):
                    raise ValueError('Close identity conflict.')
                return self._token(close_id, operation)
            if any(not item.cancelled for item in self._operations.values()) or len(self._operations) >= 4:
                raise ValueError('A close barrier is still owned.')
            resource = self.resources.hold(identity)
            pins = None
            try:
                if self.session.storage is not resource.storage:
                    raise ValueError('RMS_RECORD_SCOPE_CHANGED: The active record changed.')
                storage = resource.storage
                cutoff = storage.cutoff(freeze=True)
                pins = storage.results.capture()
                versions = pins.__enter__()
                bookmark = copy.deepcopy(storage.cursor_state())
                operation = CloseOperation(resource, cutoff, pins, versions, bookmark, bool(retain))
                self._operations[close_id] = operation
                return self._token(close_id, operation)
            except Exception:
                if pins is not None:
                    pins.__exit__(None, None, None)
                if 'cutoff' in locals():
                    resource.storage.cancel_close(cutoff)
                self.resources.release(resource)
                raise

    @staticmethod
    def _token(close_id, operation):
        cutoff = operation.cutoff
        return dict(closeId=close_id, workspaceId=operation.resource.storage.identity,
                    session=cutoff.session, contentRevision=cutoff.content, cursorSequence=cutoff.cursor)

    def prepare(self, close_id):
        """Wait outside the game lock; this ticket never captures later work."""
        with self._lock:
            operation = self._operations[workspace_identity(close_id)]
            if operation.result is not None:
                return copy.deepcopy(operation.result)
            if operation.cancelled or operation.running:
                raise ValueError('Close barrier is cancelled or already running.')
            operation.running = True
        try:
            storage = operation.resource.storage
            recovery = None
            if operation.retain:
                storage.wait_authored(operation.cutoff)
                for version in operation.versions:
                    if not version.revision:
                        continue  # Source/input rows already own these immutable facts.
                    if version.error is not None and version.raw is None and version.read is None:
                        # A previous crash's explicitly missing tail cannot be
                        # recovered by waiting. Keep its unavailable marker.
                        continue
                    storage.results.portable(version)
                    if version.durable is not None:
                        version.durable.result()
                saved = copy.deepcopy(operation.resource.saved or {})
                if (saved.get('content') == operation.cutoff.content and saved.get('target')
                        and saved.get('fileIdentity')):
                    recovery = dict(kind='source', path=saved['target'], fileIdentity=saved['fileIdentity'],
                                    bookmark=operation.bookmark, saved=saved)
                else:
                    storage.ensure_private_base()
                    recovery = dict(kind='workspace', workspaceId=storage.identity, saved=saved)
            with self._lock:
                if operation.cancelled or not storage.owns_close(operation.cutoff):
                    raise ValueError('Close was cancelled before its recovery became ready.')
                operation.result = {**self._token(close_id, operation), 'recovery': recovery}
                return copy.deepcopy(operation.result)
        finally:
            with self._lock:
                operation.running = False
                if operation.cancelled:
                    self._release(close_id, operation)

    def cancel(self, close_id):
        with self._lock:
            operation = self._operations.get(workspace_identity(close_id))
            if operation is None:
                return {'cancelled': False}
            operation.cancelled = True
            cancelled = operation.resource.storage.cancel_close(operation.cutoff)
            if not operation.running:
                self._release(close_id, operation)
            return {'cancelled': cancelled}

    def confirm(self, close_id):
        with self._lock:
            operation = self._operations[workspace_identity(close_id)]
            if operation.result is None or operation.cancelled or not operation.resource.storage.owns_close(operation.cutoff):
                raise ValueError('Close has no current complete recovery barrier.')
            recovery = operation.result['recovery']
            disposition = 'retained' if recovery and recovery['kind'] == 'workspace' else 'retention-off'
            self.resources.retire(operation.resource.storage.identity, disposition)
            self._release(close_id, operation)
            return {'confirmed': True, 'workspaceId': operation.resource.storage.identity}

    def _release(self, close_id, operation):
        self._operations.pop(close_id, None)
        operation.pins.__exit__(None, None, None)
        operation.versions = ()
        self.resources.release(operation.resource)

    def shutdown(self):
        with self._lock:
            for close_id in tuple(self._operations):
                self.cancel(close_id)
