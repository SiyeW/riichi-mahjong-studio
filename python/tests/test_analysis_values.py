import copy
from pathlib import Path
import subprocess
import sys
import unittest

from rms_backend.records.analysis_values import AnalysisReadError, JsonReference


class DeferredValue(JsonReference):
    def __init__(self, value):
        self.value = value
        self.reads = 0

    def resolve(self):
        self.reads += 1
        return self.value


class AnalysisValuesTests(unittest.TestCase):
    def test_snapshot_preserves_deferred_identity_without_reading_its_body(self):
        reference = DeferredValue({'probabilities': [0, .25, .75]})
        snapshot = copy.deepcopy({'saved': reference})
        self.assertIs(snapshot['saved'], reference)
        self.assertEqual(reference.reads, 0)
        self.assertEqual(snapshot['saved'].resolve(), reference.value)
        self.assertEqual(reference.reads, 1)
        self.assertIsInstance(AnalysisReadError('damaged'), ValueError)

    def test_native_archive_and_live_reference_share_the_contract_without_loading_legacy_codec(self):
        code = '''
import sys
from rms_backend.records.analysis_values import JsonReference
from rms_backend.records.analysis_refs import AnalysisReference
from rms_backend.records.archive import ArchiveAnalysis
assert issubclass(AnalysisReference, JsonReference)
assert issubclass(ArchiveAnalysis, JsonReference)
assert 'rms_backend.records.legacy_codec' not in sys.modules
'''
        result = subprocess.run([sys.executable, '-c', code],
                                cwd=Path(__file__).resolve().parents[1], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
