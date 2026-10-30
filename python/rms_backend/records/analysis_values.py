"""Shared deferred analysis values, independent of any archive encoding."""


class AnalysisReadError(ValueError):
    """A persisted analysis value could not be read; authored state is intact."""

    def for_raise(self):
        """Readers own their tracebacks; a stored failure never accumulates them."""
        return type(self)(*self.args)


class JsonReference:
    """Immutable deferred value; persistence can retain it without resolving."""

    def resolve(self):
        raise NotImplementedError

    def __deepcopy__(self, memo):
        return self
