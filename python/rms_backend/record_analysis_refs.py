"""Read-only node references: metadata queries never load an analysis body."""

import copy
import json

from .analysis_cache_codec import AnalysisReadError, JsonReference

_UNRESOLVED = object()


class AnalysisPending(AnalysisReadError):
    """Present saved data is awaiting a scheduled read, not missing inference."""


class AnalysisReference(dict, JsonReference):
    """Compatibility at the existing node-map boundary, with no decoded mirror.

    Production presentation explicitly asks for ready_value() or schedules a
    request. The dictionary interface is only for cheap metadata and hot values;
    it never performs I/O, starts inference or waits for the codec process.
    """

    def __init__(self, store, identity):
        self.store, self.identity = store, identity
        dict.__init__(self, ((key, metadata[1] if metadata[0] else _UNRESOLVED)
                             for key, metadata in self._fields().items()))

    def _fields(self):
        return self.store.describe(self.identity)['fields']

    @property
    def cache_key(self):
        try:
            address = json.loads(self.store.describe(self.identity)['slot'])
        except ValueError:
            return None
        return address[2] if isinstance(address, list) and len(address) == 3 else None

    @property
    def pending_io(self):
        return self.ready_value() is None

    def ready_value(self):
        return self.store.hot(self.identity)

    def request(self, *, group=None, prefetch=False, retry=False):
        return self.store.request(self.identity, group=group, prefetch=prefetch, retry=retry)

    def resolve(self):
        value = self.ready_value()
        if value is not None:
            return value
        description = self.store.describe(self.identity)
        if description['error'] is not None:
            raise description['error']
        raise AnalysisPending('Saved analysis is not ready for presentation.')

    def __getitem__(self, key):
        metadata = self._fields()[key]
        if metadata[0]:
            return metadata[1]
        return self.resolve()[key]

    def get(self, key, default=None):
        return self[key] if key in self else default

    def __contains__(self, key):
        return key in self._fields()

    def __iter__(self):
        return iter(self._fields())

    def __len__(self):
        return len(self._fields())

    def keys(self):
        return self._fields().keys()

    def items(self):
        return ((key, self[key]) for key in self)

    def values(self):
        return (self[key] for key in self)

    def copy(self):
        return dict(self.items())

    def __deepcopy__(self, memo):
        value = copy.deepcopy(self.resolve(), memo)
        memo[id(self)] = value
        return value

    def __eq__(self, other):
        if self is other:
            return True
        value = self.ready_value()
        if isinstance(other, AnalysisReference):
            return self.store is other.store and self.identity == other.identity
        return value == other if value is not None else False

    def __ne__(self, other):
        return not self == other

    def _immutable(self, *_args, **_kwargs):
        raise TypeError('Stored analysis references are immutable.')

    __setitem__ = __delitem__ = clear = pop = popitem = setdefault = update = __ior__ = _immutable


def ready_analysis(value):
    return value.ready_value() if isinstance(value, AnalysisReference) else value
