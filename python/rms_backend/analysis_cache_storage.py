"""Placement and bounded reuse of persisted per-node analysis caches."""

from __future__ import annotations

from threading import Lock

from .analysis_cache_codec import (
    pack_json, unpack_json, index_json_array, snapshot_json_object,
    json_string_seed, _encode_bitmap, _decode_bitmap,
)

ANALYSIS_CACHE_STORAGE_FIELD = "analysisCacheStorage"
ANALYSIS_CACHE_STORAGE_VERSION = 1
ANALYSIS_CACHE_CODEC = "binary-json-f64-v1"


class AnalysisCachePacker:
    """Retain one packed result per cache kind, not a second full record.

    Published cache entries are immutable and replaced wholesale. Compare their
    identities and keys (not millions of values); retain references so object-id
    reuse cannot turn changed results into a false cache hit. New snapshots
    replace this bounded cache. It is only used by the serialized export lane.
    """

    def __init__(self):
        self._packed = {}
        self._storage = None
        self._lock = Lock()

    def seed(self, kind, values, packed):
        # Migration may prune the maps after load. Retain detached maps, while
        # sharing only the immutable published result objects.
        self._packed[kind] = ([snapshot_json_object(value) for value in values], packed)

    def storage(self, candidate):
        previous = self._storage
        if previous is not None and previous["nodeIds"] == candidate["nodeIds"] and all(
            previous[kind]["presence"] == candidate[kind]["presence"]
            and previous[kind]["values"] is candidate[kind]["values"]
            for kind in ("decision", "opponent")
        ):
            return previous
        self._storage = candidate
        return candidate

    def pack(self, kind, values):
        with self._lock:
            values = [snapshot_json_object(value) for value in values]
            previous = self._packed.get(kind)
            if previous is not None:
                old_values, packed = previous
                if len(old_values) == len(values) and all(
                    isinstance(current, dict) and isinstance(old, dict)
                    and list(current) == list(old)
                    and all(current[key] is old[key] for key in current)
                    for current, old in zip(values, old_values)
                ):
                    return packed
            packed = pack_json(values, display_probabilities=True, strings_seed=json_string_seed(values))
            self._packed[kind] = (values, packed)
            return packed


def compact_record_analysis_caches(record, *, packer=None):
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
            "probabilityPrecision": "float32",
            "nodeIds": node_ids,
            "decision": {
                "presence": _encode_bitmap(decision_presence),
                "values": packer.pack("decision", decision_values) if packer else pack_json(decision_values, display_probabilities=True, strings_seed=json_string_seed(decision_values)),
            },
            "opponent": {
                "presence": _encode_bitmap(opponent_presence),
                "values": packer.pack("opponent", opponent_values) if packer else pack_json(opponent_values, display_probabilities=True, strings_seed=json_string_seed(opponent_values)),
            },
        }
        if packer:
            record[ANALYSIS_CACHE_STORAGE_FIELD] = packer.storage(record[ANALYSIS_CACHE_STORAGE_FIELD])
    return record


def expand_record_analysis_caches(record, *, packer=None, lazy=False):
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
    decode = index_json_array if lazy else unpack_json
    decision_values = decode((storage.get("decision") or {}).get("values"))
    opponent_values = decode((storage.get("opponent") or {}).get("values"))
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
    if packer and storage.get("probabilityPrecision") == "float32":
        packer.seed("decision", decision_values, storage["decision"]["values"])
        packer.seed("opponent", opponent_values, storage["opponent"]["values"])
    record.pop(ANALYSIS_CACHE_STORAGE_FIELD, None)
    return record
