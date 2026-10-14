"""Persisted shallow offsets for binary analysis caches, bound to their payload.

Validation reads dictionary headers and spans, not the nested prediction tokens.
The digest detects accidental corruption; it is not an authenticity signature.
"""

import hashlib
import json


def _digest(packed, index):
    digest = hashlib.sha256()
    for value in (packed['strings'], packed['tokens'], packed['numbers'],
                  packed['numberCount'], packed['exactZero'], index):
        data = (value.encode('ascii') if isinstance(value, str) else
                json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode('ascii'))
        digest.update(len(data).to_bytes(8, 'little'))
        digest.update(data)
    return digest.hexdigest()


def attach_index(packed, values, objects):
    index = {'version': 1, 'values': values, 'objects': objects}
    packed['index'] = {**index, 'digest': _digest(packed, index)}


def read_index(packed, source):
    """Return validated rows without walking opaque prediction subtrees."""
    def invalid():
        raise ValueError('Invalid persisted analysis cache index.')

    index = packed['index']
    if (not isinstance(index, dict) or type(index.get('version')) is not int
            or index['version'] != 1
            or set(index) != {'version', 'values', 'objects', 'digest'}):
        invalid()
    content = {key: index[key] for key in ('version', 'values', 'objects')}
    if index['digest'] != _digest(packed, content):
        invalid()
    rows, objects = index['values'], index['objects']
    if not isinstance(rows, list) or not isinstance(objects, list):
        invalid()
    tokens = source.tokens

    def unsigned(offset):
        value = 0
        for shift in range(0, 56, 7):
            if offset >= len(tokens):
                invalid()
            byte = tokens[offset]
            offset += 1
            value |= (byte & 127) << shift
            if byte < 128:
                return value, offset
        invalid()

    def row_check(row):
        if not isinstance(row, list) or len(row) != 6 or any(type(n) is not int for n in row):
            invalid()
        start, end, ordinal, count, number, nonzero = row
        if not (0 <= start < end <= len(tokens) and 0 <= ordinal <= ordinal + count <= source.number_count
                and 0 <= number <= number + nonzero <= len(source.numbers) // 8 and nonzero <= count):
            invalid()
        if count - source.zero_count(ordinal, count) != nonzero:
            invalid()
        tag = tokens[start]
        if tag > 6:
            invalid()
        if tag <= 3 and (end != start + 1 or count != (1 if tag == 3 else 0)):
            invalid()
        if tag == 4:
            string_id, after = unsigned(start + 1)
            if after != end or string_id >= len(source.strings) or count:
                invalid()

    def sequence(values, offset, ordinal, number, end, count, nonzero, fields=False):
        for entry in values:
            row = entry
            if fields:
                if not isinstance(entry, list) or len(entry) != 2:
                    invalid()
                key, row = entry
                key_id, offset = unsigned(offset)
                if type(key) is not int or key != key_id or not 0 <= key < len(source.strings):
                    invalid()
            row_check(row)
            if (row[0], row[2], row[4]) != (offset, ordinal, number):
                invalid()
            offset, ordinal, number = row[1], ordinal + row[3], number + row[5]
        if (offset, ordinal, number) != (end, count, nonzero):
            invalid()

    if not tokens or tokens[0] != 5:
        invalid()
    length, after = unsigned(1)
    if length != len(rows):
        invalid()
    sequence(rows, after, 0, 0, len(tokens), source.number_count, len(source.numbers) // 8)
    by_offset = {}
    for entry in objects:
        if not isinstance(entry, list) or len(entry) != 2:
            invalid()
        offset, fields = entry
        if type(offset) is not int or offset in by_offset or not isinstance(fields, list):
            invalid()
        by_offset[offset] = fields
    visited = set()

    def check_object(row, depth):
        start, end, ordinal, count, number, nonzero = row
        if tokens[start] != 6 or depth > 2:
            return
        fields = by_offset.get(start)
        if fields is None or start in visited:
            invalid()
        visited.add(start)
        length, after = unsigned(start + 1)
        if length != len(fields):
            invalid()
        sequence(fields, after, ordinal, number, end, ordinal + count, number + nonzero, fields=True)
        keys = [source.strings[key] for key, _ in fields]
        if len(set(keys)) != len(keys):
            invalid()
        for _, child in fields:
            check_object(child, depth + 1)

    for row in rows:
        check_object(row, 1)
    if visited != set(by_offset):
        invalid()
    return rows, objects
