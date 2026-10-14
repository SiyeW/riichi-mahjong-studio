"""Finite S/V portable export from record-owned immutable versions."""

import copy
import os
from pathlib import Path
from uuid import uuid4

from .game_record_storage import copy_game_for_record, serialize_game_record_parts
from .record_analysis_refs import AnalysisReference
from .record_archive import write_archive


class StoredRecordExport:
    """Capture under game lock, encode/stream off-lock, release pins exactly once."""

    def __init__(self, storage, game, state):
        self.storage = storage
        self.cutoff = storage.cutoff()
        self.game = {key: copy.deepcopy(value) for key, value in game.items() if key != 'nodes'}
        self.game['nodes'] = {}
        self.addresses = []
        identities = []
        for node_id, node in game['nodes'].items():
            self.game['nodes'][node_id] = {
                key: dict(value) if key == 'snapshot' else copy.deepcopy(value)
                for key, value in node.items() if key not in ('analysisCache', 'opponentAnalysisCache')}
            for field in ('analysisCache', 'opponentAnalysisCache'):
                for key, reference in node.get(field, {}).items():
                    if not isinstance(reference, AnalysisReference) or reference.store is not storage.results:
                        raise ValueError('A saved analysis is not owned by this record session.')
                    identities.append(reference.identity)
                    self.addresses.append((node_id, field, key))
        self.state = copy.deepcopy(state)
        self._pins = storage.results.capture(identities)
        self.versions = self._pins.__enter__()
        self._closed = False

    def write(self, path, *, target=None, save_id=None, app_version=''):
        """Filesystem promotion/ACK belongs to main, never to this staging writer."""
        if self._closed:
            raise RuntimeError('Stored export has already been released.')
        save_id = save_id or uuid4().hex
        target = str(Path(target or path).resolve())
        directory = str(Path(path).resolve().parent)
        recovery_error = None
        try:
            # An intent is useful for crash reconciliation but not a prerequisite
            # for rescue export onto a healthy volume.
            try:
                self.storage.writer.submit('save_intent', save_id, self.cutoff.content,
                                           self.cutoff.cursor, target).result()
            except Exception as error:
                recovery_error = str(error)
            origin = self.storage.origin_descriptor
            if origin and os.path.normcase(target) == os.path.normcase(origin['path']):
                self.storage.ensure_private_base(strict=False)
                recovery_error = self.storage.source_error or recovery_error
            record = serialize_game_record_parts(copy_game_for_record(self.game), self.state,
                                                 compact_analysis=False)
            record['metadata'] = dict(appVersion=app_version,
                                      save=dict(id=save_id, workspace=self.storage.identity,
                                                content=self.cutoff.content, cursor=self.cutoff.cursor))
            bodies, body_indices, entries = [], {}, []
            for address, version in zip(self.addresses, self.versions):
                body = self.storage.results.portable(version)
                if version.durable is not None:
                    try:
                        version.durable.result()
                    except Exception as error:
                        recovery_error = str(error)
                        body = self.storage.results.spill_failed(version, directory)
                    else:
                        body = self.storage.results.portable(version)
                # Imported alias entries share a body ID only after exact source
                # span identity; never infer equality from a digest alone.
                key = version.body_id or version.identity
                index = body_indices.get(key)
                if index is None:
                    index = body_indices[key] = len(bodies)
                    bodies.append(body)
                node_id, field, cache_key = address
                entries.append(dict(node=node_id, field=field, key=cache_key,
                                    body=index, fields=copy.deepcopy(version.fields)))
            write_archive(path, record, entries, list(self.storage.results.schemas), bodies)
            return dict(saveId=save_id, session=self.cutoff.session, workspaceId=self.storage.identity,
                        contentRevision=self.cutoff.content, cursorSequence=self.cutoff.cursor,
                        target=target, recoveryError=recovery_error)
        finally:
            self.close()

    def close(self):
        if not self._closed:
            self._closed = True
            self._pins.__exit__(None, None, None)
            self.versions = ()
