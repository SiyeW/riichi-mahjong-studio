"""Versioned binary storage for derived-analysis caches."""

from __future__ import annotations

import base64
import copy
import math
import struct
from dataclasses import dataclass
from functools import lru_cache
from itertools import chain
from threading import RLock


_NULL, _FALSE, _TRUE, _NUMBER, _STRING, _ARRAY, _OBJECT = range(7)
_BYTE_BITS = tuple(tuple(bool(byte & (1 << bit)) for bit in range(8)) for byte in range(256))
_PROBABILITY_FIELDS = frozenset((
    "probability", "winProbability", "dealInProbability", "drawProbability",
    "furitenOrNoYaku",
))


def _display_probability(value):
    # Retain relative precision for conditional probabilities and expectations.
    # Rounding every small event to an absolute percent step would corrupt both.
    # Binary32 retains about seven significant digits and compresses well in
    # the existing binary codec. Decimal rounding destroys those repeated low
    # bits and can make float32 model outputs substantially larger on disk.
    rounded = struct.unpack('<f', struct.pack('<f', value))[0]
    # Never turn a possible event into an impossible/certain one.
    return rounded if 0 < rounded < 1 and abs(rounded - value) <= value * 6e-8 else value


def _encode_bitmap(bits):
    data = bytearray((len(bits) + 7) // 8)
    for index, value in enumerate(bits):
        if value:
            data[index >> 3] |= 1 << (index & 7)
    return base64.b64encode(data).decode("ascii")


def _decode_bitmap(encoded, length):
    data = base64.b64decode(str(encoded or ""), validate=True)
    if len(data) != (length + 7) // 8:
        raise ValueError("Invalid packed analysis bitmap.")
    return list(chain.from_iterable(_BYTE_BITS[byte] for byte in data))[:length]


def pack_json(value, *, display_probabilities=False, strings_seed=()):
    strings = list(strings_seed)
    string_indexes = {text: index for index, text in enumerate(strings)}
    tokens = bytearray()
    numbers = []
    zero_bits = []

    def string_index(text):
        index = string_indexes.get(text)
        if index is not None:
            return index
        index = len(strings)
        strings.append(text)
        string_indexes[text] = index
        return index

    @lru_cache(maxsize=4096)
    def variable_unsigned(value):
        encoded = bytearray()
        while True:
            byte = value & 0x7F
            value >>= 7
            encoded.append(byte | (0x80 if value else 0))
            if not value:
                return bytes(encoded)

    def token(tag, payload=None):
        tokens.append(tag)
        if payload is not None:
            tokens.extend(variable_unsigned(payload))

    key_tokens = {}
    fragment_sources = set()

    def visit(current, probability=False):
        if isinstance(current, EncodedJsonValue):
            source = current.source
            if source not in fragment_sources:
                if strings[:len(source.strings)] != source.strings:
                    raise ValueError("Deferred JSON fragments have incompatible string tables.")
                fragment_sources.add(source)
            tokens.extend(source.tokens[current.start:current.end])
            zero_bits.extend(source.bits(current.ordinal, current.count))
            data = source.numbers[current.number * 8:(current.number + current.nonzero) * 8]
            numbers.extend(struct.unpack(f'<{current.nonzero}d', data) if data else ())
        elif current is None:
            token(_NULL)
        elif current is False:
            token(_FALSE)
        elif current is True:
            token(_TRUE)
        elif isinstance(current, (int, float)):
            number = float(current)
            if not math.isfinite(number):
                raise ValueError("Analysis cache contains a non-finite number.")
            if display_probabilities and probability and 0 < number < 1:
                number = _display_probability(number)
            token(_NUMBER)
            is_zero = number == 0
            zero_bits.append(is_zero)
            if not is_zero:
                numbers.append(number)
        elif isinstance(current, str):
            token(_STRING, string_index(current))
        elif isinstance(current, (list, tuple)):
            token(_ARRAY, len(current))
            for child in current:
                visit(child, probability)
        elif isinstance(current, dict):
            token(_OBJECT, len(current))
            for key, child in raw_json_items(current):
                if not isinstance(key, str):
                    raise ValueError("Analysis cache object keys must be strings.")
                encoded_key = key_tokens.get(key)
                if encoded_key is None:
                    encoded_key = variable_unsigned(string_index(key))
                    key_tokens[key] = encoded_key
                tokens.extend(encoded_key)
                visit(child, key in _PROBABILITY_FIELDS or key == "tiles"
                      or (probability and isinstance(child, (int, float))))
        else:
            raise ValueError(f"Unsupported analysis cache value: {type(current).__name__}")

    visit(value)
    number_data = struct.pack(f"<{len(numbers)}d", *numbers) if numbers else b""
    return {
        "strings": strings,
        "tokens": base64.b64encode(tokens).decode("ascii"),
        "numbers": base64.b64encode(number_data).decode("ascii"),
        "numberCount": len(zero_bits),
        "exactZero": _encode_bitmap(zero_bits),
    }


def unpack_json(packed):
    if not isinstance(packed, dict) or not isinstance(packed.get("strings"), list):
        raise ValueError("Invalid packed analysis payload.")
    token_data = base64.b64decode(str(packed.get("tokens") or ""), validate=True)
    number_data = base64.b64decode(str(packed.get("numbers") or ""), validate=True)
    if len(number_data) % 8:
        raise ValueError("Invalid packed analysis binary data.")
    number_count = packed.get("numberCount")
    if not isinstance(number_count, int) or isinstance(number_count, bool) or number_count < 0:
        raise ValueError("Invalid packed analysis number count.")
    zero_bits = _decode_bitmap(packed.get("exactZero"), number_count)
    return _unpack_parts(packed["strings"], token_data, number_data, zero_bits)


def _unpack_parts(strings, token_data, number_data, zero_bits):
    raw_numbers = iter(struct.unpack(f"<{len(number_data) // 8}d", number_data) if number_data else ())
    # Validate once, then use iterator exhaustion for bounds checking. Most
    # indexes are one byte; avoid millions of nested varint calls and len checks.
    if len(zero_bits) - sum(zero_bits) != len(number_data) // 8:
        raise ValueError("Packed analysis number count does not match its bitmap.")
    numbers = iter([0.0 if zero else next(raw_numbers) for zero in zero_bits])
    tokens = iter(token_data)

    def unsigned(first):
        value = first & 0x7F
        shift = 7
        for _ in range(7):
            byte = next(tokens)
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                return value
            shift += 7
        raise ValueError("Packed analysis index is too large.")

    def read(tag):
        if tag == _NUMBER:
            return next(numbers)
        if tag == _NULL:
            return None
        if tag == _FALSE:
            return False
        if tag == _TRUE:
            return True
        if tag not in (_STRING, _ARRAY, _OBJECT):
            raise ValueError(f"Unknown packed analysis tag: {tag}")
        first = next(tokens)
        payload = first if first < 128 else unsigned(first)
        if tag == _STRING:
            return strings[payload]
        if tag == _ARRAY:
            # Probability vectors dominate files. Decode scalar vector entries
            # directly instead of a recursive Python call for every number.
            return [next(numbers) if (child_tag := next(tokens)) == _NUMBER
                    else read(child_tag) for _ in range(payload)]
        value = {}
        for _ in range(payload):
            first = next(tokens)
            key = strings[first if first < 128 else unsigned(first)]
            child_tag = next(tokens)
            value[key] = next(numbers) if child_tag == _NUMBER else read(child_tag)
        return value

    try:
        value = read(next(tokens))
    except (StopIteration, IndexError) as error:
        raise ValueError("Packed analysis payload ended unexpectedly or has an invalid index.") from error
    sentinel = object()
    if next(tokens, sentinel) is not sentinel or next(numbers, sentinel) is not sentinel:
        raise ValueError("Packed analysis payload contains trailing data.")
    return value


@dataclass(frozen=True, slots=True)
class EncodedJsonValue:
    source: 'PackedJsonIndex'
    start: int
    end: int
    ordinal: int
    count: int
    number: int
    nonzero: int

    def __deepcopy__(self, memo):
        # Encoded bytes and spans are immutable. A save snapshot retains them
        # without decoding fields the user has never viewed.
        return self


class DeferredJsonObject(dict):
    """Dictionary interface with independently decoded, immutable JSON fields."""

    def __init__(self, fields):
        super().__init__(fields)
        self._resolved = {}
        self._lock = RLock()

    def __getitem__(self, key):
        with self._lock:
            raw = dict.__getitem__(self, key)
            if not isinstance(raw, EncodedJsonValue):
                return raw
            if key not in self._resolved:
                self._resolved[key] = raw.source.read(raw)
            return self._resolved[key]

    def __iter__(self):
        # Ensure dict(object) uses mapping access rather than copying hidden
        # encoded values through CPython's exact-dictionary fast path.
        return dict.__iter__(self)

    def get(self, key, default=None):
        return self[key] if key in self else default

    def items(self):
        return ((key, self[key]) for key in self)

    def values(self):
        return (self[key] for key in self)

    def __setitem__(self, key, value):
        with self._lock:
            self._resolved.pop(key, None)
            dict.__setitem__(self, key, value)

    def __delitem__(self, key):
        with self._lock:
            self._resolved.pop(key, None)
            dict.__delitem__(self, key)

    def clear(self):
        with self._lock:
            self._resolved.clear()
            dict.clear(self)

    def pop(self, key, *default):
        if key not in self:
            return dict.pop(self, key, *default)
        value = self[key]
        del self[key]
        return value

    def popitem(self):
        if not self:
            raise KeyError('popitem(): dictionary is empty')
        key = next(reversed(self))
        return key, self.pop(key)

    def setdefault(self, key, default=None):
        if key not in self:
            self[key] = default
        return self[key]

    def update(self, *args, **kwargs):
        for key, value in dict(*args, **kwargs).items():
            self[key] = value

    def __ior__(self, other):
        self.update(other)
        return self

    def copy(self):
        return dict(self.items())

    def __deepcopy__(self, memo):
        result = {}
        memo[id(self)] = result
        for key, value in self.items():
            result[key] = copy.deepcopy(value, memo)
        return result

    def __eq__(self, other):
        return self.copy() == (other.copy() if isinstance(other, DeferredJsonObject) else other)

    def __ne__(self, other):
        return not self == other


def raw_json_items(value):
    """Snapshot/encoding access, distinct from the materialized dict interface."""
    return dict.items(value) if isinstance(value, DeferredJsonObject) else value.items()


def snapshot_json_object(value):
    return dict(raw_json_items(value)) if isinstance(value, dict) else value


def json_string_seed(value):
    """Find the source table without resolving any deferred fields."""
    if isinstance(value, EncodedJsonValue):
        return value.source.strings
    children = (item for _, item in raw_json_items(value)) if isinstance(value, dict) else value if isinstance(value, (list, tuple)) else ()
    for child in children:
        seed = json_string_seed(child)
        if seed:
            return seed
    return ()


class PackedJsonIndex:
    """Validate tokens and index cache fields without constructing their arrays.

    Existing files remain readable; this is an in-memory index, not a new codec.
    Top-level cache/model fields are indexed once. Deeper objects are indexed
    only when requested; numeric arrays are decoded only when actually read.
    """

    def __init__(self, packed):
        if not isinstance(packed, dict) or not isinstance(packed.get('strings'), list):
            raise ValueError('Invalid packed analysis payload.')
        self.strings = packed['strings']
        self.tokens = base64.b64decode(str(packed.get('tokens') or ''), validate=True)
        self.numbers = base64.b64decode(str(packed.get('numbers') or ''), validate=True)
        self.number_count = packed.get('numberCount')
        if (not isinstance(self.number_count, int) or isinstance(self.number_count, bool)
                or self.number_count < 0 or len(self.numbers) % 8):
            raise ValueError('Invalid packed analysis number count.')
        self.zeros = base64.b64decode(str(packed.get('exactZero') or ''), validate=True)
        if len(self.zeros) != (self.number_count + 7) // 8:
            raise ValueError('Invalid packed analysis bitmap.')
        if self.number_count - self.zero_count(0, self.number_count) != len(self.numbers) // 8:
            raise ValueError('Packed analysis number count does not match its bitmap.')
        self.fields = {}
        self.array_decodes = 0

    def zero_count(self, start, count):
        if not count:
            return 0
        end = start + count
        first, last = start // 8, (end - 1) // 8
        if first == last:
            return ((self.zeros[first] >> (start % 8)) & ((1 << count) - 1)).bit_count()
        total = (self.zeros[first] >> (start % 8)).bit_count()
        total += int.from_bytes(self.zeros[first + 1:last], 'little').bit_count()
        return total + (self.zeros[last] & ((1 << ((end - 1) % 8 + 1)) - 1)).bit_count()

    def bits(self, start, count):
        data = self.zeros[start // 8:(start + count + 7) // 8]
        bits = list(chain.from_iterable(_BYTE_BITS[byte] for byte in data))
        return bits[start % 8:start % 8 + count]

    def read(self, span):
        if self.tokens[span.start] == _OBJECT:
            fields = self.fields.get(span.start)
            if fields is None:
                cursor = _TokenCursor(self, span.start, span.ordinal, span.number)
                cursor.scan(2)
                fields = self.fields.setdefault(span.start, cursor.fields[span.start])
            return DeferredJsonObject(fields)
        if self.tokens[span.start] == _ARRAY:
            self.array_decodes += 1
        return _unpack_parts(
            self.strings, self.tokens[span.start:span.end],
            self.numbers[span.number * 8:(span.number + span.nonzero) * 8],
            self.bits(span.ordinal, span.count),
        )

    def array(self):
        cursor = _TokenCursor(self)
        try:
            if cursor.byte() != _ARRAY:
                raise ValueError('Packed analysis cache values must be an array.')
            values = []
            for _ in range(cursor.unsigned()):
                before = cursor.position()
                cursor.scan(1)
                values.append(cursor.span(before))
            if (cursor.offset != len(self.tokens) or cursor.ordinal != self.number_count
                    or cursor.number * 8 != len(self.numbers)):
                raise ValueError('Packed analysis payload contains trailing data.')
        except (IndexError, KeyError) as error:
            raise ValueError('Packed analysis payload ended unexpectedly or has an invalid index.') from error
        self.fields = cursor.fields
        return [self.read(span) for span in values]


class _TokenCursor:
    def __init__(self, source, offset=0, ordinal=0, number=0):
        self.source = source
        self.offset, self.ordinal, self.number = offset, ordinal, number
        self._number_ordinal = ordinal
        self.fields = {}

    def byte(self):
        value = self.source.tokens[self.offset]
        self.offset += 1
        return value

    def unsigned(self):
        first = self.source.tokens[self.offset]
        if first < 128:
            self.offset += 1
            return first
        value, shift = 0, 0
        for _ in range(8):
            byte = self.byte()
            value |= (byte & 127) << shift
            if not byte & 128:
                return value
            shift += 7
        raise ValueError('Packed analysis index is too large.')

    def position(self):
        count = self.ordinal - self._number_ordinal
        self.number += count - self.source.zero_count(self._number_ordinal, count)
        self._number_ordinal = self.ordinal
        return self.offset, self.ordinal, self.number

    def span(self, before):
        self.position()
        offset, ordinal, number = before
        return EncodedJsonValue(self.source, offset, self.offset, ordinal,
                                self.ordinal - ordinal, number, self.number - number)

    def numbers(self, count):
        if self.ordinal + count > self.source.number_count:
            raise ValueError('Packed analysis number bitmap ended unexpectedly.')
        self.ordinal += count

    def scan(self, depth):
        start = self.offset
        tokens = self.source.tokens
        tag = tokens[self.offset]
        self.offset += 1
        if tag == _NUMBER:
            ordinal = self.ordinal
            if ordinal >= self.source.number_count:
                raise ValueError('Packed analysis number bitmap ended unexpectedly.')
            self.ordinal += 1
        elif tag in (_NULL, _FALSE, _TRUE):
            return
        elif tag == _STRING:
            self.source.strings[self.unsigned()]
        elif tag == _ARRAY:
            count = self.unsigned()
            end = self.offset + count
            if end <= len(self.source.tokens) and self.source.tokens.count(_NUMBER, self.offset, end) == count:
                self.numbers(count)
                self.offset = end
            else:
                for _ in range(count):
                    self.scan(depth + 1)
        elif tag == _OBJECT:
            fields = [] if depth <= 2 else None
            for _ in range(self.unsigned()):
                index = tokens[self.offset]
                self.offset += 1
                if index >= 128:
                    second = tokens[self.offset]
                    self.offset += 1
                    if second < 128:
                        index = (index & 127) | (second << 7)
                    else:
                        self.offset -= 2
                        index = self.unsigned()
                key = self.source.strings[index]
                before = self.position() if fields is not None else None
                child_tag = tokens[self.offset]
                if child_tag == _NUMBER:
                    ordinal = self.ordinal
                    if ordinal >= self.source.number_count:
                        raise ValueError('Packed analysis number bitmap ended unexpectedly.')
                    self.ordinal += 1
                    self.offset += 1
                elif child_tag in (_NULL, _FALSE, _TRUE):
                    self.offset += 1
                else:
                    self.scan(depth + 1)
                if fields is not None:
                    fields.append((key, self.span(before)))
            if fields is not None:
                self.fields[start] = tuple(fields)
        else:
            raise ValueError(f'Unknown packed analysis tag: {tag}')


def index_json_array(packed):
    return PackedJsonIndex(packed).array()
