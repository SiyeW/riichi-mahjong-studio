"""Captured portable saves stay owned through host promotion/ACK or actual abort."""

from dataclasses import dataclass
from collections import OrderedDict
from pathlib import Path
from threading import RLock

from .record_resource_manager import workspace_identity
from .record_stored_export import StoredRecordExport
from .record_archive import read_archive

TOKEN_FIELDS = ('saveId', 'workspaceId', 'session', 'contentRevision', 'cursorSequence', 'pathIntent', 'target')


@dataclass
class SaveOperation:
    resource: object
    snapshot: object
    target: str
    intent: int
    app_version: str
    token: dict
    staging: str | None = None
    result: dict | None = None
    writing: bool = False
    aborted: bool = False


class RecordSaveOperations:
    def __init__(self, resources, session, *, limit=4):
        self.resources, self.session = resources, session
        self._lock = RLock()
        self._operations = {}
        self._receipts = OrderedDict()
        self._limit = limit

    def capture(self, identity, save_id, target, intent, app_version=''):
        save_id = workspace_identity(save_id)
        target = str(Path(target).resolve())
        if Path(target).is_relative_to(self.resources.root):
            raise ValueError('Portable saves cannot overwrite private recovery resources.')
        if type(intent) is not int or intent <= 0:
            raise ValueError('Invalid save path intent.')
        with self._lock:
            existing = self._operations.get(save_id)
            if existing is not None:
                if (existing.resource.storage.identity, existing.target, existing.intent) != (identity, target, intent):
                    raise ValueError('Save identity has already captured another operation.')
                return dict(existing.token)
            if len(self._operations) >= self._limit:
                raise RuntimeError('Too many owned record saves are pending.')
            resource = self.resources.hold(identity)
            try:
                if self.session.storage is not resource.storage:
                    raise ValueError('RMS_RECORD_SCOPE_CHANGED: The active record changed.')
                snapshot = self.session.prepare_export()
                if not isinstance(snapshot, StoredRecordExport):
                    raise ValueError('Record save requires owned storage.')
            except Exception:
                self.resources.release(resource)
                raise
            token = dict(saveId=save_id, workspaceId=identity, session=snapshot.cutoff.session,
                         contentRevision=snapshot.cutoff.content, cursorSequence=snapshot.cutoff.cursor,
                         pathIntent=intent, target=target)
            self._operations[save_id] = SaveOperation(resource, snapshot, target, intent, app_version, token)
            return dict(token)

    def write(self, save_id, path):
        with self._lock:
            operation = self._operations[workspace_identity(save_id)]
            path = str(Path(path).resolve())
            if path != operation.target + '.' + save_id + '.tmp':
                raise ValueError('Save staging path does not match its captured identity.')
            if operation.staging is not None and operation.staging != path:
                raise ValueError('Save staging identity conflict.')
            if operation.result is not None:
                return dict(operation.result)
            if operation.writing or operation.aborted:
                raise ValueError('Save write is already running or aborted.')
            if operation.snapshot is None:
                raise ValueError('Failed staging requires a new captured save operation.')
            operation.writing, operation.staging = True, path
        try:
            result = operation.snapshot.write(path, target=operation.target, save_id=save_id,
                                              app_version=operation.app_version, path_intent=operation.intent)
            with self._lock:
                operation.result = result
            return result
        finally:
            with self._lock:
                operation.writing = False
                operation.snapshot.close()
                operation.snapshot = None
                if operation.aborted:
                    self._release(save_id, operation)

    def committed(self, token):
        token = {key: token[key] for key in TOKEN_FIELDS}
        with self._lock:
            save_id = workspace_identity(token['saveId'])
            receipt = self._receipts.get(save_id)
            if receipt is not None:
                if any(token.get(key) != value for key, value in receipt.items() if key != 'committed'):
                    raise ValueError('Save acknowledgement receipt identity mismatch.')
                return dict(receipt)
            operation = self._operations.get(save_id)
            if operation is not None:
                if operation.result is None or operation.aborted:
                    raise ValueError('Save has no complete staging result to acknowledge.')
                if any(token.get(key) != value for key, value in operation.token.items()):
                    raise ValueError('Save acknowledgement does not match its captured identity.')
        if operation is None:
            return self._durable_ack(token)
        file_identity = operation.result['fileIdentity']
        operation.resource.storage.writer.submit('save_committed', save_id,
            token['contentRevision'], token['cursorSequence'], file_identity).result()
        with self._lock:
            self.resources.mark_saved(operation.resource, token, file_identity)
            receipt = self._remember(token)
            self._release(save_id, operation)
        return receipt

    def _remember(self, token):
        receipt = {**token, 'committed': True}
        with self._lock:
            self._receipts[token['saveId']] = receipt
            while len(self._receipts) > 128:
                self._receipts.popitem(last=False)
        return dict(receipt)

    def _durable_ack(self, token):
        # Lost reply/backend restart: immutable intent identity survives the
        # runtime session. Never restore an old table or touch another record.
        resource = self.resources.hold(token['workspaceId'])
        try:
            row = resource.storage.writer.submit('save_receipt', token['saveId']).result()
            if row is None or any(row[key] != token.get(key) for key in row if key != 'committed'):
                raise ValueError('Save has no matching durable intent.')
            resource.storage.writer.submit('save_committed', token['saveId'],
                token['contentRevision'], token['cursorSequence']).result()
            saved = resource.storage.writer.ready.result().metadata().get('saved') or {}
            self.resources.mark_saved(resource, token, saved.get('fileIdentity'))
            return self._remember(token)
        finally:
            self.resources.release(resource)

    def reconcile(self, resource):
        """Only pending intents, only native directories; never scan saved bodies."""
        errors = []
        writer = resource.storage.writer
        for save_id, content, cursor, target, intent in writer.submit('pending_save_intents').result():
            try:
                with open(target, 'rb') as file:
                    archive = read_archive(file)
                    saved = archive.record.get('metadata', {}).get('save')
                    expected = dict(id=save_id, workspace=resource.storage.identity,
                                    content=content, cursor=cursor, intent=intent)
                    if saved != expected:
                        writer.submit('abort_save', save_id).result()
                        continue
                    file_identity = archive.source.identity
                writer.submit('save_committed', save_id, content, cursor, file_identity).result()
                self.resources.mark_saved(resource, dict(saveId=save_id, contentRevision=content,
                    cursorSequence=cursor, target=target, pathIntent=intent), file_identity)
            except FileNotFoundError:
                writer.submit('abort_save', save_id).result()
            except (OSError, ValueError, EOFError) as error:
                errors.append(dict(saveId=save_id, error=str(error)))
        return errors

    def _release(self, save_id, operation):
        if self._operations.get(save_id) is operation:
            self._operations.pop(save_id)
            if operation.snapshot is not None:
                operation.snapshot.close()
                operation.snapshot = None
            self.resources.release(operation.resource)

    def abort(self, save_id, *, preserve_intent=False):
        with self._lock:
            operation = self._operations.get(workspace_identity(save_id))
            if operation is None:
                if save_id in self._receipts:
                    return {'aborted': False, 'writing': False, 'committed': True}
                return {'aborted': True, 'writing': False}
            operation.aborted = True
            if not operation.writing:
                if not preserve_intent:
                    operation.resource.storage.writer.submit('abort_save', save_id)
                self._release(save_id, operation)
            return {'aborted': not operation.writing, 'writing': operation.writing}

    def shutdown(self):
        with self._lock:
            for save_id in tuple(self._operations):
                self.abort(save_id, preserve_intent=True)
