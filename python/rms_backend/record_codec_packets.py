"""Primitive-only adaptation of immutable legacy fragments for private codec IPC."""

from .analysis_cache_codec import EncodedJsonValue, _BYTE_BITS, _unpack_parts, raw_json_items


def result_packet(value):
    """Run outside the game lock. No deferred arrays are resolved in the parent."""
    # Import lazily: the worker's primitive decoder does not need file owners.
    from .record_blocks import BlockResult
    if isinstance(value, BlockResult):
        original = ('v1', value.entry.source.read_block(value.entry.descriptor),
                    value.entry.descriptor['fields'])
        if value.pristine():
            return original
        changed = [(key, result_packet(child)) for key, child in raw_json_items(value)
                   if key not in value._original or child is not value._original[key]]
        return ('v1-patch', original, changed, [key for key in value._original if key not in value])
    if isinstance(value, EncodedJsonValue):
        source = value.source
        first, end = value.ordinal // 8, (value.ordinal + value.count + 7) // 8
        return ('fragment', source.strings, source.tokens[value.start:value.end],
                source.numbers[value.number * 8:(value.number + value.nonzero) * 8],
                source.zeros[first:end], value.ordinal % 8, value.count)
    if isinstance(value, dict):
        return ('object', [(key, result_packet(child)) for key, child in raw_json_items(value)])
    if isinstance(value, (list, tuple)):
        if all(child is None or type(child) in (str, bool, int, float) for child in value):
            return ('plain', value)  # Do not wrap every model probability in a tuple.
        return ('array', [result_packet(child) for child in value])
    if value is None or type(value) in (str, bool, int, float):
        return ('scalar', value)
    raise ValueError('Unsupported record analysis input.')


def materialize_packet(packet):
    """Private packets only; public files NEVER use pickle or this grammar."""
    kind, *payload = packet
    if kind in ('scalar', 'plain'):
        return payload[0]
    if kind == 'json-input':
        from .record_binary import RESULT_LIMIT, load_json
        value = load_json(payload[0], limit=RESULT_LIMIT)
        if not isinstance(value, dict):
            raise ValueError('Imported analysis input must be an object.')
        return value
    if kind == 'object':
        return {key: materialize_packet(child) for key, child in payload[0]}
    if kind == 'array':
        return [materialize_packet(child) for child in payload[0]]
    if kind == 'fragment':
        strings, tokens, numbers, zeros, offset, count = payload
        bits = [bit for byte in zeros for bit in _BYTE_BITS[byte]][offset:offset + count]
        return _unpack_parts(strings, tokens, numbers, bits)
    if kind == 'v1':
        import copy
        from .analysis_cache_codec import index_json_array
        from .record_binary import RESULT_LIMIT, inflate, load_json
        compressed, fields = payload
        values = index_json_array(load_json(inflate(compressed, RESULT_LIMIT)))
        if len(values) != 1 or not isinstance(values[0], dict):
            raise ValueError('Invalid legacy analysis body.')
        result = copy.deepcopy(values[0])
        if list(result) != list(fields) or any(meta[0] and result[key] != meta[1]
                                              for key, meta in fields.items()):
            raise ValueError('Legacy analysis summary does not match its body.')
        return result
    if kind == 'v1-patch':
        source, changed, deleted = payload
        result = materialize_packet(source)
        for key in deleted:
            result.pop(key, None)
        result.update((key, materialize_packet(child)) for key, child in changed)
        return result
    raise ValueError('Unknown private record input kind.')


def resident_size(value):
    """Account owned Python objects off the gameplay lock, not only packed bytes."""
    import sys
    seen, pending, size = set(), [value], 0
    while pending:
        current = pending.pop()
        identity = id(current)
        if identity in seen:
            continue
        seen.add(identity)
        size += sys.getsizeof(current)
        if isinstance(current, dict):
            pending.extend(current)
            pending.extend(current.values())
        elif isinstance(current, (list, tuple)):
            pending.extend(current)
    return size
