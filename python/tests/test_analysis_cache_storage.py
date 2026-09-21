import copy
import json
from pathlib import Path
import unittest

from rms_backend.analysis_cache_storage import (
    ANALYSIS_CACHE_STORAGE_FIELD,
    compact_record_analysis_caches,
    expand_record_analysis_caches,
    pack_json,
    unpack_json,
)


class AnalysisCacheStorageTests(unittest.TestCase):
    def test_binary_json_matches_shared_cross_runtime_fixture(self):
        fixture_path = Path(__file__).parents[2] / "test" / "fixtures" / "analysis-cache-storage-v1.json"
        fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
        self.assertEqual(pack_json(fixture["source"]), fixture["packed"])
        self.assertEqual(unpack_json(fixture["packed"]), fixture["source"])

    def test_binary_json_preserves_float64_and_exact_zero(self):
        source = {
            "finite": [0, 0.00000014975917395076976, 0.6132425665855408, -2500.5],
            "nested": {
                "value": 4,
                "probability": 0,
                "label": "1m",
                "available": True,
                "missing": None,
            },
            "repeated": [{"value": 1, "label": "1m"}, {"value": 2, "label": "1m"}],
        }
        packed = pack_json(source)
        self.assertEqual(unpack_json(packed), source)
        self.assertEqual(packed["strings"].count("probability"), 1)
        self.assertEqual(packed["strings"].count("1m"), 1)
        self.assertTrue(packed["exactZero"])

    def test_record_round_trip_preserves_presence_and_does_not_mutate_copy_source(self):
        source = {
            "formatVersion": 3,
            "game": {
                "nodes": {
                    "a": {"children": ["b"], "analysisCache": {}},
                    "b": {
                        "children": ["c"],
                        "opponentAnalysisCache": {
                            "model": {
                                "outputs": {
                                    "opponent-deal-in-probability": {
                                        "players": [
                                            {"seat": 1, "tiles": {"1m": 0, "2m": 1.4975917395076976e-7}}
                                        ]
                                    }
                                }
                            }
                        },
                    },
                    "c": {"children": []},
                }
            },
        }
        record = copy.deepcopy(source)
        compact_record_analysis_caches(record)
        self.assertIn(ANALYSIS_CACHE_STORAGE_FIELD, record)
        self.assertNotIn("analysisCache", record["game"]["nodes"]["a"])
        expand_record_analysis_caches(record)
        self.assertEqual(record, source)

    def test_unknown_storage_versions_are_rejected(self):
        record = {"game": {"nodes": {"a": {"analysisCache": {"result": 1}}}}}
        compact_record_analysis_caches(record)
        record[ANALYSIS_CACHE_STORAGE_FIELD]["schemaVersion"] = 99
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            expand_record_analysis_caches(record)


if __name__ == "__main__":
    unittest.main()
