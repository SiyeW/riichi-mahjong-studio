"""Bounded primitives shared by native record and analysis-body readers.

These routines parse data, never process instructions or perform file I/O.
"""

from __future__ import annotations

import json
import math
import re
import struct
import zlib

DIRECTORY_LIMIT = 64 * 1024 * 1024
RESULT_LIMIT = 32 * 1024 * 1024
LEGACY_LIMIT = 256 * 1024 * 1024
JSON_DEPTH_LIMIT = 96
JSON_ITEMS_LIMIT = 2_000_000
U64 = struct.Struct('<Q')
F64 = struct.Struct('<d')
F32 = struct.Struct('<f')
_JSON_STRINGS = re.compile(rb'"(?:[^"\\]|\\.)*"')
_JSON_CONTAINERS = re.compile(rb'[{}\[\]]')


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'),
                      allow_nan=False).encode('utf-8')


def inflate(data, limit, *, members=False):
    """Validate gzip including CRC while limiting *produced* output.

    Concatenation/zero padding is accepted only for the legacy gzip reader.
    The one excess output byte detects an overrun without allocating its tail.
    """
    output = bytearray()
    remaining = data
    while remaining:
        decoder = zlib.decompressobj(wbits=31)
        try:
            decoded = decoder.decompress(remaining, limit - len(output) + 1)
        except zlib.error as error:
            raise ValueError('Damaged compressed record data.') from error
        output.extend(decoded)
        if len(output) > limit or decoder.unconsumed_tail:
            raise ValueError('Record data exceeds its expansion limit.')
        if not decoder.eof:
            raise EOFError('Incomplete compressed record data.')
        remaining = decoder.unused_data
        if not members and remaining:
            raise ValueError('Trailing compressed record data.')
        if members:
            remaining = remaining.lstrip(b'\0')
    if not data:
        raise EOFError('Empty compressed record data.')
    return bytes(output)


def load_json(data, *, limit=RESULT_LIMIT, items_limit=JSON_ITEMS_LIMIT):
    """Bound depth/container growth before the JSON parser allocates objects."""
    if len(data) > limit:
        raise ValueError('Record JSON exceeds its size limit.')
    # Remove strings in C, count separators in C, and visit only container
    # boundaries in Python. A directory should not pay one Python iteration per
    # byte, scalar or key merely to establish depth/size safety.
    structural = _JSON_STRINGS.sub(b'', data)
    items = sum(structural.count(token) for token in (b',', b':', b'[', b'{'))
    if items > items_limit:
        raise ValueError('Record JSON exceeds its item limit.')
    depth = 0
    for match in _JSON_CONTAINERS.finditer(structural):
        byte = structural[match.start()]
        if byte in (91, 123):
            depth += 1
            if depth > JSON_DEPTH_LIMIT:
                raise ValueError('Record JSON exceeds its depth limit.')
        elif byte in (93, 125):
            depth -= 1

    def invalid_constant(value):
        raise ValueError(f'Invalid JSON number: {value}')

    def finite_float(value):
        result = float(value)
        if not math.isfinite(result):
            raise ValueError('Nonfinite JSON number.')
        return result

    return json.loads(data.decode('utf-8-sig'), parse_constant=invalid_constant,
                      parse_float=finite_float)


def unsigned(value):
    if type(value) is not int or not 0 <= value < 1 << 64:
        raise ValueError('Invalid unsigned record integer.')
    result = bytearray()
    while value >= 128:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return result


class Cursor:
    """Exact bounded binary stream; no implicit padding or trailing bytes."""

    def __init__(self, data):
        self.data, self.offset = memoryview(data), 0

    def take(self, count):
        if type(count) is not int or count < 0 or count > len(self.data) - self.offset:
            raise ValueError('Incomplete record binary stream.')
        start = self.offset
        self.offset += count
        return self.data[start:self.offset]

    def number(self, layout):
        return layout.unpack(self.take(layout.size))[0]

    def unsigned(self):
        value = 0
        for shift in range(0, 70, 7):
            byte = self.take(1)[0]
            value |= (byte & 127) << shift
            if byte < 128:
                if value >= 1 << 64 or (shift and byte == 0):
                    break
                return value
        raise ValueError('Invalid record varint.')

    def finish(self):
        if self.offset != len(self.data):
            raise ValueError('Trailing record binary stream data.')


def pack_codes(codes):
    """Pack paired 20-bit values without a temporary per-bit array."""
    result = bytearray()
    bits = count = 0
    for code in codes:
        bits |= code << count
        count += 20
        while count >= 8:
            result.append(bits & 255)
            bits >>= 8
            count -= 8
    if count:
        result.append(bits)
    return result


def unpack_codes(data, count):
    if len(data) != (count * 20 + 7) // 8:
        raise ValueError('Invalid probability code length.')
    bits = available = position = 0
    for _ in range(count):
        while available < 20:
            bits |= data[position] << available
            position += 1
            available += 8
        yield bits & 0xfffff
        bits >>= 20
        available -= 20
    if bits:
        raise ValueError('Nonzero probability padding.')
