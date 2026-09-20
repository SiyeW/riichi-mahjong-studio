"""Versioned, lossless storage for large derived-analysis caches."""

from __future__ import annotations

import base64
import struct


ANALYSIS_CACHE_STORAGE_FIELD = "analysisCacheStorage"
ANALYSIS_CACHE_STORAGE_VERSION = 1
ANALYSIS_CACHE_CODEC = "binary-json-f64-v1"

_NULL, _FALSE, _TRUE, _NUMBER, _STRING, _ARRAY, _OBJECT = range(7)


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
    return [bool(data[index >> 3] & (1 << (index & 7))) for index in range(length)]


def pack_json(value):
    strings = []
    string_indexes = {}
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

    def variable_unsigned(value):
        if not isinstance(value, int) or value < 0:
            raise ValueError("Invalid packed analysis index.")
        while True:
            byte = value & 0x7F
            value >>= 7
            tokens.append(byte | (0x80 if value else 0))
            if not value:
                return

    def token(tag, payload=None):
        tokens.append(tag)
        if payload is not None:
            variable_unsigned(payload)

    def visit(current):
        if current is None:
            token(_NULL)
        elif current is False:
            token(_FALSE)
        elif current is True:
            token(_TRUE)
        elif isinstance(current, (int, float)):
            number = float(current)
            if number != number or number in (float("inf"), float("-inf")):
                raise ValueError("Analysis cache contains a non-finite number.")
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
                visit(child)
        elif isinstance(current, dict):
            token(_OBJECT, len(current))
            for key, child in current.items():
                if not isinstance(key, str):
                    raise ValueError("Analysis cache object keys must be strings.")
                variable_unsigned(string_index(key))
                visit(child)
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
    tokens = token_data
    numbers = struct.unpack(f"<{len(number_data) // 8}d", number_data) if number_data else ()
    number_count = packed.get("numberCount")
    if not isinstance(number_count, int) or isinstance(number_count, bool) or number_count < 0:
        raise ValueError("Invalid packed analysis number count.")
    zero_bits = _decode_bitmap(packed.get("exactZero"), number_count)
    token_index = number_index = number_ordinal = 0

    def variable_unsigned():
        nonlocal token_index
        value = 0
        shift = 0
        for _ in range(8):
            if token_index >= len(tokens):
                raise ValueError("Packed analysis index ended unexpectedly.")
            byte = tokens[token_index]
            token_index += 1
            value |= (byte & 0x7F) << shift
            if not byte & 0x80:
                return value
            shift += 7
        raise ValueError("Packed analysis index is too large.")

    def read():
        nonlocal token_index, number_index, number_ordinal
        if token_index >= len(tokens):
            raise ValueError("Packed analysis payload ended unexpectedly.")
        tag = tokens[token_index]
        token_index += 1
        if tag == _NULL:
            return None
        if tag == _FALSE:
            return False
        if tag == _TRUE:
            return True
        if tag == _NUMBER:
            if number_ordinal >= len(zero_bits):
                raise ValueError("Packed analysis number bitmap ended unexpectedly.")
            is_zero = zero_bits[number_ordinal]
            number_ordinal += 1
            if is_zero:
                return 0.0
            if number_index >= len(numbers):
                raise ValueError("Packed analysis number data ended unexpectedly.")
            value = numbers[number_index]
            number_index += 1
            return value
        if tag == _STRING:
            payload = variable_unsigned()
            if payload >= len(packed["strings"]):
                raise ValueError("Packed analysis string index is out of range.")
            return packed["strings"][payload]
        if tag == _ARRAY:
            return [read() for _ in range(variable_unsigned())]
        if tag == _OBJECT:
            value = {}
            for _ in range(variable_unsigned()):
                key_index = variable_unsigned()
                if key_index >= len(packed["strings"]):
                    raise ValueError("Packed analysis key index is out of range.")
                value[packed["strings"][key_index]] = read()
            return value
        raise ValueError(f"Unknown packed analysis tag: {tag}")

    value = read()
    if token_index != len(tokens) or number_ordinal != number_count or number_index != len(numbers):
        raise ValueError("Packed analysis payload contains trailing data.")
    return value


def compact_record_analysis_caches(record):
    nodes = (record.get("game") or {}).get("nodes") if isinstance(record, dict) else None
    if not isinstance(nodes, dict):
        return record
    node_ids = list(nodes)
    decision_presence = []
    opponent_presence = []
    decision_values = []
    opponent_values = []
    changed = False
    for node in nodes.values():
        decision_present = isinstance(node, dict) and "analysisCache" in node
        opponent_present = isinstance(node, dict) and "opponentAnalysisCache" in node
        decision_presence.append(decision_present)
        opponent_presence.append(opponent_present)
        if decision_present:
            decision_values.append(node.pop("analysisCache"))
            changed = True
        if opponent_present:
            opponent_values.append(node.pop("opponentAnalysisCache"))
            changed = True
    if changed:
        record[ANALYSIS_CACHE_STORAGE_FIELD] = {
            "schemaVersion": ANALYSIS_CACHE_STORAGE_VERSION,
            "codec": ANALYSIS_CACHE_CODEC,
            "nodeIds": node_ids,
            "decision": {
                "presence": _encode_bitmap(decision_presence),
                "values": pack_json(decision_values),
            },
            "opponent": {
                "presence": _encode_bitmap(opponent_presence),
                "values": pack_json(opponent_values),
            },
        }
    return record


def expand_record_analysis_caches(record):
    storage = record.get(ANALYSIS_CACHE_STORAGE_FIELD) if isinstance(record, dict) else None
    if storage is None:
        return record
    if storage.get("schemaVersion") != ANALYSIS_CACHE_STORAGE_VERSION or storage.get("codec") != ANALYSIS_CACHE_CODEC:
        raise ValueError("Unsupported analysis cache storage format.")
    nodes = (record.get("game") or {}).get("nodes")
    node_ids = list(nodes) if isinstance(nodes, dict) else None
    if node_ids is None or storage.get("nodeIds") != node_ids:
        raise ValueError("Packed analysis cache node order does not match the record tree.")
    decision_presence = _decode_bitmap((storage.get("decision") or {}).get("presence"), len(node_ids))
    opponent_presence = _decode_bitmap((storage.get("opponent") or {}).get("presence"), len(node_ids))
    decision_values = unpack_json((storage.get("decision") or {}).get("values"))
    opponent_values = unpack_json((storage.get("opponent") or {}).get("values"))
    if (
        not isinstance(decision_values, list)
        or not isinstance(opponent_values, list)
        or len(decision_values) != sum(decision_presence)
        or len(opponent_values) != sum(opponent_presence)
    ):
        raise ValueError("Packed analysis cache value count does not match its presence bitmap.")
    decision_index = opponent_index = 0
    for index, node_id in enumerate(node_ids):
        node = nodes[node_id]
        if decision_presence[index]:
            node["analysisCache"] = decision_values[decision_index]
            decision_index += 1
        if opponent_presence[index]:
            node["opponentAnalysisCache"] = opponent_values[opponent_index]
            opponent_index += 1
    record.pop(ANALYSIS_CACHE_STORAGE_FIELD, None)
    return record
