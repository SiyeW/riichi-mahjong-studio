"""Inference admission and transfer into the active record's immutable facts."""

import copy
from dataclasses import dataclass
from threading import Timer

from .analysis_cache import ANALYSIS_SOURCES_FIELD, cache_key_context
from .record_analysis_refs import AnalysisReference
from .record_session_storage import result_slot


@dataclass(eq=False)
class AnalysisTicket:
    storage: object
    admission: object
    game: dict
    kind: str
    role: str
    engine_epoch: int
    cancelled: bool = False


class RecordAnalysisAccess:
    """All methods are called under the game lock. No body decode/copy/fsync."""

    def __init__(self, state, state_lock, storage, epochs):
        self.state, self.storage, self.epochs = state, storage, epochs
        self.state_lock = state_lock
        self._tickets = set()
        self._deferred = {}

    def enabled(self, game):
        return game is self.state.get('game') and self.storage() is not None

    def reserve(self, game, kind, *, foreground=False, role='foreground'):
        storage = self.storage()
        if not self.enabled(game):
            return None
        admission = storage.reserve_analysis(foreground=foreground)
        if admission is None:
            return None
        ticket = AnalysisTicket(storage, admission, game, kind, role, self.epochs(kind))
        self._tickets.add(ticket)
        return ticket

    def cancel(self, ticket=None, *, role=None, kind=None):
        if ticket is None:
            for key in tuple(self._deferred):
                if (role is None or key[0] == role) and (kind is None or key[1] == kind):
                    self._deferred.pop(key).cancel()
        for current in (tuple(self._tickets) if ticket is None else (ticket,)):
            if (current not in self._tickets or role is not None and current.role != role
                    or kind is not None and current.kind != kind):
                continue
            self._tickets.remove(current)
            current.cancelled = True
            current.admission.reservation.release()

    def defer(self, game, kind, callback, *, role='foreground'):
        """One bounded retry timer per role/kind, never an executor backlog.

        Storage can pause inference for slow/fsync/error conditions without
        occupying a gameplay thread. Close/reset cancels these timers outright.
        """
        key, storage = (role, kind), self.storage()
        if key in self._deferred or not self.enabled(game):
            return
        def retry():
            with self.state_lock:
                if self._deferred.get(key) is not timer:
                    return
                self._deferred.pop(key)
                if self.state.get('game') is game and self.storage() is storage:
                    callback()
        timer = Timer(.25, retry)
        timer.daemon = True
        self._deferred[key] = timer
        timer.start()

    def store(self, ticket, game, node, key, value, source):
        if (ticket is None or ticket not in self._tickets or ticket.cancelled
                or ticket.game is not game or game is not self.state.get('game')
                or ticket.storage is not self.storage() or ticket.engine_epoch != self.epochs(ticket.kind)
                or game.get('nodes', {}).get(node.get('id')) is not node):
            if ticket is not None:
                self.cancel(ticket)
            return None
        field = 'analysisCache' if ticket.kind == 'decision' else 'opponentAnalysisCache'
        cache = node.setdefault(field, {})
        address = cache_key_context(key)
        if address is None or address['kind'] != ticket.kind or address['sourceId'] != source.get('id'):
            self.cancel(ticket)
            return None
        obsolete = [old for old in cache if old != key and (candidate := cache_key_context(old))
                    and address and all(candidate[name] == address[name] for name in ('kind', 'seat', 'mode'))]
        sources = copy.deepcopy(game.get(ANALYSIS_SOURCES_FIELD) or {})
        registered = {**sources.get(source['id'], {}), **copy.deepcopy(source)}
        if value.get('engineFingerprint'):
            registered['engineFingerprint'] = str(value['engineFingerprint'])
        sources[source['id']] = registered
        slot = result_slot(node['id'], field, key)
        if ticket.kind == 'decision':
            value = {key: item for key, item in value.items() if key not in ('engineFingerprint', 'hostPostprocessorVersion')}
        identity = ticket.storage.accept_analysis(ticket.admission, slot, value,
            epoch=ticket.storage.results.epoch(slot), kind=ticket.kind, seat=(address or {}).get('seat'),
            superseded=[result_slot(node['id'], field, old) for old in obsolete],
            metadata={f'game:{ANALYSIS_SOURCES_FIELD}': sources})
        self._tickets.remove(ticket)
        ticket.cancelled = True  # Ownership now belongs to the record, never to a cancelled model task.
        if identity is None:
            return None
        for old in obsolete:
            del cache[old]
        game[ANALYSIS_SOURCES_FIELD] = sources
        reference = AnalysisReference(ticket.storage.results, identity)
        cache[key] = reference
        return reference
