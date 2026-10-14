"""Main/backend record handoffs; disk waits never hold the live game lock."""

from dataclasses import replace
from pathlib import Path

from .record_close_operations import RecordCloseOperations
from .record_resource_manager import RecordResourceManager
from .record_save_operations import RecordSaveOperations

REPLACEMENTS = {'create_game', 'import_game_record', 'import_mortal_report',
                'import_custom_tenhou', 'import_replay_file'}


class RecordLifecycle:
    def __init__(self, root, scheduler, session, state_lock, dispatcher, view_builder,
                 *, view_context, emit=lambda event: None, cancel_analysis=lambda: None):
        self.session, self.lock = session, state_lock
        self.dispatcher, self.view_builder = dispatcher.dispatch, view_builder
        self.cancel_analysis = cancel_analysis
        self.view_context = view_context
        self.resources = RecordResourceManager(Path(root), scheduler, emit=emit)
        session.configure_storage(self.resources.create)
        session.dependencies = replace(session.dependencies, storage_changed=self.resources.activate)
        self.saves = RecordSaveOperations(self.resources, session)
        self.closes = RecordCloseOperations(self.resources, session)
        dispatcher.validate_record_scope = self.validate_scope

    def validate_scope(self, command, data):
        if data.get('recordScope') is not None:
            storage = self.session.storage
            if storage is None or storage.session_id != data['recordScope']:
                raise ValueError('RMS_RECORD_SCOPE_CHANGED: The record changed before this command.')
        scope = data.get('recordViewScope')
        if scope is not None:
            current = self.view_context.current()
            fields = ('sessionId', 'nodeId', 'seat', 'mode', 'intent') if command in (
                'submit_user_action', 'advance_game', 'confirm_pending_review', 'import_wall') else ('sessionId',)
            if current is None or any(scope.get(key) != current.get(key) for key in fields):
                raise ValueError('RMS_RECORD_SCOPE_CHANGED: The displayed position changed before this command.')

    def dispatch(self, request_id, command, payload):
        data = payload or {}
        if command in REPLACEMENTS:
            identity = data.get('workspaceId')
            with self.resources.candidate(identity, baseline=data.get('savedBaseline') or {}):
                response = self.dispatcher(request_id, command, data)
            return {**response, 'recordRuntime': self.resources.runtime()}
        if command == 'record_restore':
            identity = data.get('workspaceId')
            with self.resources.candidate(identity):
                storage, game, state = self.resources.restore(identity)
                save_errors = self.saves.reconcile(self.resources.resource(identity))
                prepared = self.session.prepare_restored(storage, game, state)
                with self.lock:
                    self.session.activate_load(prepared)
                    response = self.view_builder.build_response(request_id, command)
            return {**response, 'recordRuntime': self.resources.runtime(),
                    'recoveryError': storage.source_error, 'saveReconciliationErrors': save_errors}
        if command == 'record_confirm_activation':
            result = self.resources.confirm_activation(data.get('workspaceId'), data.get('previous'))
        elif command == 'record_save_capture':
            with self.lock:
                result = self.saves.capture(data.get('workspaceId'), data.get('saveId'),
                    data.get('target'), data.get('pathIntent'), data.get('appVersion', ''))
        elif command == 'record_save_write':
            result = self.saves.write(data.get('saveId'), data.get('path'))
        elif command == 'record_save_committed':
            result = self.saves.committed(data)
        elif command == 'record_save_abort':
            result = self.saves.abort(data.get('saveId'))
        elif command == 'record_close_capture':
            with self.lock:
                self.cancel_analysis()
                result = self.closes.capture(data.get('workspaceId'), data.get('closeId'), retain=data.get('retain'))
        elif command == 'record_close_prepare':
            result = self.closes.prepare(data.get('closeId'))
        elif command == 'record_close_cancel':
            with self.lock:
                result = self.closes.cancel(data.get('closeId'))
        elif command == 'record_close_confirm':
            result = self.closes.confirm(data.get('closeId'))
        elif command == 'record_wait_released':
            result = self.resources.wait_released(data.get('workspaceId'))
        elif command == 'record_abandon':
            result = self.resources.abandon(data.get('workspaceId'))
        elif command == 'record_flush':
            with self.lock:
                resource = self.resources.resource(data.get('workspaceId'), active=True)
                cutoff = resource.storage.cutoff()
            resource.storage.wait_authored(cutoff)
            result = self.resources.runtime()
        elif command == 'record_runtime':
            result = self.resources.runtime()
        else:
            response = self.dispatcher(request_id, command, data)
            return {**response, 'recordRuntime': self.resources.runtime()}
        return {'request_id': request_id, 'command': command, 'result': result,
                'recordRuntime': self.resources.runtime()}

    def shutdown(self):
        with self.lock:
            self.cancel_analysis()
        self.closes.shutdown()
        self.saves.shutdown()
        self.resources.shutdown()
