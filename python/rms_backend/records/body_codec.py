"""Canonical analysis facts, typed shared schemas and useful numeric precision.

Only recognized protocol fields are quantized. Decision/unknown data remains
lossless. A schema is data, not an executable template or an engine-key sentinel.
"""

from __future__ import annotations

import math
import struct

from .binary import (
    Cursor, F32, F64, U64, RESULT_LIMIT, JSON_DEPTH_LIMIT, JSON_ITEMS_LIMIT,
    json_bytes, load_json, unsigned, pack_codes, unpack_codes,
)
from ..riichi_score_values import possible_hand_value

BODY_HEADER = struct.Struct('<IIQQQ')
ESCAPE32, ESCAPE64 = 0xffffe, 0xfffff
SMALL_OUTPUTS = frozenset((
    'opponent-concealed-tile-count', 'wall-tile-count', 'opponent-dora-count',
    'match-placement',
))
SCORE_OUTPUTS = frozenset(('opponent-score', 'kyoku-score-delta', 'match-score'))
KNOWN_OUTPUTS = SMALL_OUTPUTS | SCORE_OUTPUTS | {
    'opponent-shanten', 'opponent-deal-in-probability', 'kyoku-outcome',
}
POLICY = 'sparse-p20-ticks-v1'


def probability_code(value, *, exact=False):
    """Complement coding preserves rare events near either endpoint."""
    if value == 0:
        return 0, b'', 0.0
    if value == 1:
        return 1, b'', 1.0
    if not math.isfinite(value) or not 0 < value < 1:
        raise ValueError('Invalid compact probability.')
    inner = min(value, 1 - value)
    word = struct.unpack('<I', F32.pack(inner))[0]
    code = (((word + 1024) >> 11) << 1) | (value > .5)
    rounded_inner = F32.unpack(struct.pack('<I', (code >> 1) << 11))[0]
    restored = 1 - rounded_inner if code & 1 else rounded_inner
    tolerance = min(.00005, .0002 * inner)
    if not exact and 0 < restored < 1 and abs(restored - value) <= tolerance:
        return code, b'', restored
    single = F32.unpack(F32.pack(value))[0]
    if single == value:
        return ESCAPE32, F32.pack(single), value
    return ESCAPE64, F64.pack(value), value


def decode_probability(code, escapes=None):
    if code in (ESCAPE32, ESCAPE64):
        if escapes is None:
            raise ValueError('Missing probability escape.')
        value = escapes.number(F32 if code == ESCAPE32 else F64)
    else:
        inner = F32.unpack(struct.pack('<I', (code >> 1) << 11))[0]
        value = 1 - inner if code & 1 else inner
    if not math.isfinite(value) or not 0 < value <= 1:
        # Zero is implicit, never stored in the nonzero stream.
        raise ValueError('Invalid nonzero probability code.')
    return value


def _number(value):
    return (type(value) is float and math.isfinite(value)
            or type(value) is int and abs(value) < 1 << 53)


def _quantity(output, path):
    """Recognize protocol paths, not arbitrary keys named 'probability'."""
    key = path[-1] if path else None
    if output not in KNOWN_OUTPUTS:
        return None
    if output == 'kyoku-outcome' and len(path) == 3 and path[0] == 'outcomes' and type(path[1]) is int and key == 'probability':
        return 'p'
    if output == 'opponent-shanten' and len(path) == 3 and path[0] == 'players' and type(path[1]) is int and key == 'furitenOrNoYaku':
        return 'p'
    if output == 'opponent-shanten' and len(path) == 5 and path[0] == 'players' and type(path[1]) is int and path[2] == 'shanten' and type(path[3]) is int and key == 'probability':
        return 'p'
    if output == 'opponent-deal-in-probability' and len(path) == 4 and path[0] == 'players' and type(path[1]) is int and path[2] == 'tiles':
        return 'p'
    prefix = path
    if len(prefix) >= 2 and prefix[0] == 'players' and type(prefix[1]) is int:
        prefix = prefix[2:]
    if output in ('opponent-concealed-tile-count', 'wall-tile-count'):
        if len(prefix) >= 2 and prefix[0] in ('tiles', 'redTiles') and isinstance(prefix[1], str):
            prefix = prefix[2:]
        else:
            return None
    elif not (len(path) >= 3 and path[0] == 'players' and type(path[1]) is int and prefix[0] == 'prediction'):
        return None
    else:
        prefix = prefix[1:]
    if len(prefix) == 3 and prefix[0] == 'distribution' and type(prefix[1]) is int and prefix[2] == 'probability':
        return 'p'
    if len(prefix) == 1 and key in ('expectedValue', 'pointEstimate'):
        if output in SMALL_OUTPUTS:
            return 'milli'
        if output in SCORE_OUTPUTS:
            return 'point'
    return None


def _distribution_safe(before, after, output):
    """Preserve conditional support, ranking and derived numeric meaning."""
    if not before:
        return True
    old = [item['probability'] for item in before]
    new = [item['probability'] for item in after]
    a, b = math.fsum(old), math.fsum(new)
    if abs(a - b) > .0001 or (abs(a - 1) <= .0001 and abs(b - 1) > .0001):
        return False
    if a and b and max(abs(x / a - y / b) for x, y in zip(old, new)) > .0001:
        return False
    axes = [item.get('value') for item in before]
    if all(_number(value) for value in axes):
        budget = .5 if output in SCORE_OUTPUTS else .0005
        if abs(math.fsum((x - y) * v for x, y, v in zip(old, new, axes))) > budget:
            return False
        if a and b:
            error = abs(math.fsum((x / a - y / b) * v for x, y, v in zip(old, new, axes)))
            if error > budget:
                return False
    if output == 'opponent-score':
        # Preserve nomination ordering, including ties, under any dealer filter.
        ordering = sorted(range(len(old)), key=lambda index: (-old[index], index))
        for left, right in zip(ordering, ordering[1:]):
            if ((old[left] == old[right]) != (new[left] == new[right])
                    or new[left] < new[right]):
                return False
        # The view excludes impossible dealer/non-dealer values, then may
        # normalize the surviving subset. A safe full mean is not sufficient.
        for dealer in (False, True):
            indexes = [i for i, value in enumerate(axes) if _number(value) and possible_hand_value(value, dealer)]
            if len(indexes) == len(before) or not indexes:
                continue
            left, right = [old[i] for i in indexes], [new[i] for i in indexes]
            sa, sb = math.fsum(left), math.fsum(right)
            if sa and sb:
                # Match the renderer's 1e-4 normalization threshold exactly.
                left = [p / sa if abs(sa - 1) > .0001 else p for p in left]
                right = [p / sb if abs(sb - 1) > .0001 else p for p in right]
                if max(abs(x - y) for x, y in zip(left, right)) > .0001:
                    return False
                if abs(math.fsum((x - y) * axes[i] for i, x, y in zip(indexes, left, right))) > .5:
                    return False
    return True


def _unsafe_groups(before, after, output, path=()):
    """Return only affected distribution paths for exact probability escapes."""
    unsafe = set()
    if isinstance(before, dict):
        for key, child in before.items():
            if isinstance(child, (dict, list)):
                unsafe.update(_unsafe_groups(child, after[key], output, path + (key,)))
    elif isinstance(before, list):
        if before and all(isinstance(item, dict) and _number(item.get('probability')) for item in before):
            if not _distribution_safe(before, after, output):
                unsafe.add(path)
            if output == 'kyoku-outcome':
                for seat in range(4):
                    for role in ('actor', 'target', 'winner'):
                        indexes = [i for i, row in enumerate(before) if row.get(role) == seat
                                   or role == 'winner' and seat in row.get('winners', [])]
                        if not _distribution_safe([before[i] for i in indexes], [after[i] for i in indexes], output):
                            unsafe.add(path)
                    targets_before, targets_after = {}, {}
                    for left, right in zip(before, after):
                        if left.get('winner') == seat or seat in left.get('winners', []):
                            target = seat if left.get('type') == 'tsumo' else left.get('target')
                            targets_before[target] = targets_before.get(target, 0) + left['probability']
                            targets_after[target] = targets_after.get(target, 0) + right['probability']
                    if not _distribution_safe(
                            [{'probability': p} for p in targets_before.values()],
                            [{'probability': targets_after[key]} for key in targets_before], output):
                        unsafe.add(path)
            # Standard entries contain axes and one probability, not nested
            # distributions. Skip their scalar leaves instead of allocating
            # sets/paths for every axis/value in every frame.
            for index, row in enumerate(before):
                for key, child in row.items():
                    if isinstance(child, (dict, list)):
                        unsafe.update(_unsafe_groups(child, after[index][key], output, path + (index, key)))
        else:
            for index, child in enumerate(before):
                if isinstance(child, (dict, list)):
                    unsafe.update(_unsafe_groups(child, after[index], output, path + (index,)))
    return unsafe


def _projection(outputs, seat):
    # Imported lazily; worker entry does not import service, engines or models.
    from ..analysis_cache import compact_opponent_analysis
    from ..opponent_prediction_protocol import OpponentPredictionProtocolAdapter
    adapter = OpponentPredictionProtocolAdapter()
    players = adapter.validate_prediction(
        {'outputs': [{'id': key, 'data': value} for key, value in outputs.items()]},
        controlled_seat=seat, enabled_outputs=tuple(outputs),
        output_references={key: {} for key in outputs})
    host = adapter.to_host_result(players, protocol_outputs={}, controlled_seat=seat,
                                 context={}, engine_fingerprint='', target_events=None)
    return compact_opponent_analysis(host)['predictions']


def _schema_tree(value, output=None, path=()):
    visited = 0

    def walk(child, trail, depth):
        nonlocal visited
        visited += 1
        if depth > JSON_DEPTH_LIMIT or visited > JSON_ITEMS_LIMIT:
            raise ValueError('Analysis schema exceeds its structure limit.')
        if isinstance(child, dict):
            return ['o', [[key, walk(item, trail + (key,), depth + 1)] for key, item in child.items()]]
        if isinstance(child, list):
            return ['a', [walk(item, trail + (i,), depth + 1) for i, item in enumerate(child)]]
        quantity = _quantity(output, trail)
        if _number(child) and quantity == 'p' and 0 <= child <= 1:
            return ['p']
        if _number(child) and quantity in ('milli', 'point') and abs(child) < 1 << 52:
            return ['n', 1000 if quantity == 'milli' else 1]
        if type(child) is float and math.isfinite(child):
            return ['f']
        # Axes and small fixed domain constants belong in shared schemas.
        if child is None or type(child) is bool or type(child) is int and abs(child) <= 65535:
            return ['c', child]
        if isinstance(child, str) and len(child) <= 32:
            return ['c', child]
        return ['j']

    return walk(value, path, 0)


def compile_schema(encoded):
    """Validate once per shape; the bounded cache stores no result values."""
    schema = load_json(encoded)
    counts = [0, 0, 0, 0]

    def walk(node, depth=0):
        counts[3] += 1
        if counts[3] > JSON_ITEMS_LIMIT or depth > JSON_DEPTH_LIMIT or not isinstance(node, list) or not node:
            raise ValueError('Invalid analysis schema.')
        tag = node[0]
        if tag == 'o' and len(node) == 2 and isinstance(node[1], list):
            keys = set()
            children = []
            for pair in node[1]:
                if (not isinstance(pair, list) or len(pair) != 2 or not isinstance(pair[0], str)
                        or pair[0] in keys):
                    raise ValueError('Invalid analysis object schema.')
                keys.add(pair[0])
                children.append((pair[0], walk(pair[1], depth + 1)))
            return ('o', tuple(children))
        if tag == 'a' and len(node) == 2 and isinstance(node[1], list):
            return ('a', tuple(walk(child, depth + 1) for child in node[1]))
        if tag == 'c' and len(node) == 2 and not isinstance(node[1], (dict, list)):
            return ('c', node[1])
        if tag == 'p' and len(node) == 1:
            counts[0] += 1
            return ('p',)
        if tag == 'n' and len(node) == 2 and type(node[1]) is int and node[1] in (1, 1000):
            counts[1] += 1
            return ('n', node[1])
        if tag == 'f' and len(node) == 1:
            counts[1] += 1
            return ('f',)
        if tag == 'j' and len(node) == 1:
            counts[2] += 1
            return ('j',)
        raise ValueError('Invalid analysis schema node.')

    tree = walk(schema['tree'])
    projection = schema.get('projection')
    if projection is not None and (type(projection) is not int or projection not in range(4)):
        raise ValueError('Invalid analysis projection seat.')
    return tree, tuple(counts[:3]), projection


def _restore(tree, probabilities, scalars, opaque):
    tag = tree[0]
    if tag == 'o':
        return {key: _restore(child, probabilities, scalars, opaque) for key, child in tree[1]}
    if tag == 'a':
        return [_restore(child, probabilities, scalars, opaque) for child in tree[1]]
    if tag == 'c':
        return tree[1]
    if tag == 'p':
        return next(probabilities)
    if tag == 'n':
        token = scalars.unsigned()
        if token == 0:
            value = scalars.number(F64)
            if not math.isfinite(value):
                raise ValueError('Nonfinite analysis scalar.')
            return value
        token -= 1
        return ((token >> 1) ^ -(token & 1)) / tree[1]
    if tag == 'f':
        value = scalars.number(F64)
        if not math.isfinite(value):
            raise ValueError('Nonfinite analysis scalar.')
        return value
    return load_json(bytes(opaque.take(opaque.number(U64))))


class _ShapeMismatch(Exception):
    pass


def _extract(tree, value, exact_groups=frozenset()):
    """Reuse compiled accessors; do not rebuild/serialize a template per frame."""
    probabilities, scalars, opaque = [], bytearray(), bytearray()

    def walk(node, current, path=()):
        tag = node[0]
        if tag == 'o':
            if not isinstance(current, dict) or tuple(current) != tuple(key for key, _ in node[1]):
                raise _ShapeMismatch
            for key, child in node[1]:
                walk(child, current[key], path + (key,))
        elif tag == 'a':
            if not isinstance(current, list) or len(current) != len(node[1]):
                raise _ShapeMismatch
            for index, child in enumerate(node[1]):
                walk(child, current[index], path + (index,))
        elif tag == 'c':
            if type(current) is not type(node[1]) or current != node[1]:
                raise _ShapeMismatch
        elif tag == 'p':
            if not _number(current) or not 0 <= current <= 1:
                raise _ShapeMismatch
            probabilities.append(probability_code(current, exact=any(
                path[:len(group)] == group for group in exact_groups)))
        elif tag == 'n':
            if not _number(current) or abs(current) >= 1 << 52:
                raise _ShapeMismatch
            scale = node[1]
            tick = math.floor(current * scale + .5)
            proposed = tick / scale
            if abs(proposed - current) <= (.0005 if scale == 1000 else .5) and (current == 0 or proposed != 0):
                scalars.extend(unsigned(((tick << 1) ^ (tick >> 63)) + 1))
            else:
                scalars.extend(b'\0' + F64.pack(current))
        elif tag == 'f':
            if not _number(current):
                raise _ShapeMismatch
            scalars.extend(F64.pack(current))
        else:
            data = json_bytes(current)
            opaque.extend(U64.pack(len(data)))
            opaque.extend(data)

    walk(tree, value)
    return probabilities, scalars, opaque


class AnalysisBodyCodec:
    """Append-only schema namespace, shared by one record's immutable bodies."""

    def __init__(self, schemas=()):
        self.schemas = list(schemas)
        self._ids = {}
        self._compiled = []
        self._families = {}
        for index, schema in enumerate(self.schemas):
            encoded = json_bytes(schema)
            self._compiled.append(compile_schema(encoded))
            self._ids[encoded] = index

    def encode(self, result, *, kind='opponent', seat=None):
        if not isinstance(result, dict):
            raise ValueError('Analysis result must be an object.')
        if kind != 'opponent' or not isinstance(result.get('outputs'), dict):
            data = json_bytes(result)
            if len(data) > RESULT_LIMIT - 9:
                raise ValueError('Analysis body exceeds its size limit.')
            return b'\0' + U64.pack(len(data)) + data

        facts = dict(result)
        project = None
        if type(seat) is int and seat in range(4) and 'predictions' in facts:
            try:
                if _projection(facts['outputs'], seat) == facts['predictions']:
                    project = seat
            except (RuntimeError, ValueError, KeyError, TypeError):
                pass
        projection_before = facts.pop('predictions') if project is not None else None
        # Existing float32-derived/rounded legacy displays can cross a display
        # step after p20 rounding. Exact escapes for their small source subset
        # preserve one authoritative representation without a duplicate display
        # vector or a second full encoding pass.
        exact_groups = {('outputs', name) for name in (
            'opponent-shanten', 'opponent-deal-in-probability')} if project is not None else set()
        family = (tuple(facts), tuple(facts['outputs']), project)
        candidates = self._families.setdefault(family, [])
        schema_id = None
        for candidate in candidates:
            try:
                probabilities, final_scalars, final_opaque = _extract(self._compiled[candidate][0], facts, exact_groups)
                schema_id = candidate
                break
            except _ShapeMismatch:
                continue
        if schema_id is None:
            fields = []
            for key, value in facts.items():
                if key == 'outputs':
                    children = [[output, _schema_tree(child, output)] for output, child in value.items()]
                    fields.append([key, ['o', children]])
                else:
                    fields.append([key, _schema_tree(value)])
            schema = {'tree': ['o', fields], 'projection': project}
            encoded = json_bytes(schema)
            schema_id = self._ids.get(encoded)
            if schema_id is None:
                compiled = compile_schema(encoded)
                schema_id = len(self.schemas)
                self.schemas.append(schema)
                self._compiled.append(compiled)
                self._ids[encoded] = schema_id
            if schema_id not in candidates:
                candidates.insert(0, schema_id)
                del candidates[8:]
            probabilities, final_scalars, final_opaque = _extract(self._compiled[schema_id][0], facts, exact_groups)
        tree = self._compiled[schema_id][0]
        restored = _restore(tree, iter(p[2] for p in probabilities), Cursor(final_scalars), Cursor(final_opaque))
        unsafe = set()
        for output, value in facts['outputs'].items():
            if output in KNOWN_OUTPUTS:
                unsafe.update(('outputs', output) + group for group in _unsafe_groups(
                    value, restored['outputs'][output], output))
        if unsafe:
            probabilities, final_scalars, final_opaque = _extract(tree, facts, unsafe | exact_groups)
            restored = _restore(tree, iter(p[2] for p in probabilities), Cursor(final_scalars), Cursor(final_opaque))
        if project is not None:
            # A disagreeing legacy projection remains lossless, not overwritten.
            try:
                if _projection(restored['outputs'], project) != projection_before:
                    return self.encode(result, kind=kind, seat=None)
            except (RuntimeError, ValueError, KeyError, TypeError):
                return self.encode(result, kind=kind, seat=None)
        coordinates, codes, escapes = bytearray(), [], bytearray()
        previous = -1
        for index, (code, extra, _) in enumerate(probabilities):
            if code:
                coordinates.extend(unsigned(index - previous - 1))
                previous = index
                codes.append(code)
                escapes.extend(extra)
        data = (b'\1' + BODY_HEADER.pack(schema_id, len(codes), len(coordinates),
                 len(final_scalars), len(final_opaque)) + coordinates + pack_codes(codes)
                + escapes + final_scalars + final_opaque)
        if len(data) > RESULT_LIMIT:
            raise ValueError('Analysis body exceeds its size limit.')
        return data

    def decode(self, data):
        if len(data) > RESULT_LIMIT:
            raise ValueError('Analysis body exceeds its size limit.')
        cursor = Cursor(data)
        mode = cursor.take(1)[0]
        if mode == 0:
            result = load_json(bytes(cursor.take(cursor.number(U64))))
            cursor.finish()
            if not isinstance(result, dict):
                raise ValueError('Analysis result must be an object.')
            return result
        if mode != 1:
            raise ValueError('Unknown analysis body mode.')
        schema_id, count, coordinate_size, scalar_size, opaque_size = BODY_HEADER.unpack(cursor.take(BODY_HEADER.size))
        if schema_id >= len(self.schemas):
            raise ValueError('Unknown analysis schema.')
        tree, counts, projection = self._compiled[schema_id]
        if count > counts[0]:
            raise ValueError('Too many nonzero probabilities.')
        coordinates = Cursor(cursor.take(coordinate_size))
        codes = list(unpack_codes(cursor.take((count * 20 + 7) // 8), count))
        escape_size = sum(4 if code == ESCAPE32 else 8 if code == ESCAPE64 else 0 for code in codes)
        escapes = Cursor(cursor.take(escape_size))
        scalars, opaque = Cursor(cursor.take(scalar_size)), Cursor(cursor.take(opaque_size))
        cursor.finish()
        probabilities = [0.0] * counts[0]
        previous = -1
        for code in codes:
            previous += coordinates.unsigned() + 1
            if previous >= counts[0] or code == 0:
                raise ValueError('Invalid nonzero probability coordinate/code.')
            probabilities[previous] = decode_probability(code, escapes)
        coordinates.finish()
        escapes.finish()
        result = _restore(tree, iter(probabilities), scalars, opaque)
        scalars.finish()
        opaque.finish()
        if not isinstance(result, dict):
            raise ValueError('Analysis result must be an object.')
        if projection is not None:
            result['predictions'] = _projection(result['outputs'], projection)
        return result
