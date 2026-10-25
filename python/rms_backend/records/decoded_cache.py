"""One byte-budgeted canonical-result LRU, with explicit dirty/use protection."""

from __future__ import annotations

from collections import OrderedDict
from contextlib import contextmanager
from dataclasses import dataclass
from threading import RLock


@dataclass
class _Entry:
    value: object
    size: int
    reloadable: bool
    pins: int = 0
    retired: bool = False

    @property
    def protected(self):
        return bool(self.pins or not self.reloadable)


class DecodedAnalysisCache:
    """Size is supplied by the codec owner, never scanned under gameplay lock.

    Cache eviction is NOT a data deletion or a saved/durable revision. Accepted
    values are protected until the store has an owned reloadable encoding.
    """

    def __init__(self, budget):
        self._lock = RLock()
        self._entries = OrderedDict()
        self._resident = self._protected = 0
        self._hits = self._misses = self._evictions = 0
        self._budget = self._valid_budget(budget)

    @staticmethod
    def _valid_budget(value):
        if type(value) is not int or value <= 0:
            raise ValueError('Decoded analysis budget must be positive bytes.')
        return value

    def _remove(self, key):
        entry = self._entries.pop(key)
        self._resident -= entry.size
        if entry.protected:
            self._protected -= entry.size

    def _trim(self):
        for key in tuple(self._entries):
            if self._resident <= self._budget:
                break
            entry = self._entries[key]
            if not entry.protected:
                self._remove(key)
                self._evictions += 1

    def put(self, key, value, size, *, reloadable):
        if type(size) is not int or size < 0:
            raise ValueError('Invalid decoded analysis size.')
        with self._lock:
            old = self._entries.get(key)
            if old is not None:
                if old.value is not value or old.size != size:
                    raise ValueError('Immutable result cache identity conflict.')
                return
            entry = _Entry(value, size, bool(reloadable))
            self._entries[key] = entry
            self._resident += size
            if entry.protected:
                self._protected += size
            self._trim()

    def get(self, key):
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or entry.retired:
                self._misses += 1
                return None
            self._entries.move_to_end(key)
            self._hits += 1
            return entry.value

    def backed(self, key):
        """Only the result owner may confirm a complete reloadable encoding."""
        with self._lock:
            entry = self._entries.get(key)
            if entry is not None:
                protected = entry.protected
                entry.reloadable = True
                if protected and not entry.protected:
                    self._protected -= entry.size
                self._trim()

    @contextmanager
    def borrow(self, key):
        with self._lock:
            entry = self._entries.get(key)
            if entry is None or entry.retired:
                raise KeyError(key)
            if not entry.protected:
                self._protected += entry.size
            entry.pins += 1
            self._entries.move_to_end(key)
        try:
            yield entry.value
        finally:
            with self._lock:
                entry.pins -= 1
                if not entry.protected:
                    self._protected -= entry.size
                if entry.retired and not entry.pins:
                    self._remove(key)
                self._trim()

    def discard(self, key):
        """Explicit epoch/delete invalidation, not automatic memory eviction."""
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return
            if entry.pins:
                entry.retired = True
            else:
                self._remove(key)

    def set_budget(self, budget):
        with self._lock:
            self._budget = self._valid_budget(budget)
            self._trim()

    def metrics(self):
        with self._lock:
            return {'residentBytes': self._resident, 'budgetBytes': self._budget,
                    'protectedBytes': self._protected,
                    'protectedOvershootBytes': max(0, self._resident - self._budget),
                    'entries': len(self._entries), 'hits': self._hits,
                    'misses': self._misses, 'evictions': self._evictions}
