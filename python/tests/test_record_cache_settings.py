import json
from pathlib import Path
import shutil
import subprocess
import unittest

from rms_backend.records.cache_settings import POLICY, cache_budget_bytes


class RecordCacheSettingsTests(unittest.TestCase):
    def test_default_bounds_and_invalid_values_have_matching_runtime_meaning(self):
        values = [None, 1, 32, 4096, 0, -1, 4097, 1.5, True, '64', float('nan'), float('inf')]
        expected = [32, 1, 32, 4096, 32, 32, 32, 32, 32, 32, 32, 32]
        self.assertEqual([cache_budget_bytes(value) // (1024 * 1024) for value in values], expected)
        portable_values = values[:-2]
        result = subprocess.run([shutil.which('node'), '-e',
            'const {normalizeRecordSettings}=require("./electron/main/state/settings"); '
            'const p=require("./electron/record-cache-policy.json"); '
            'console.log(JSON.stringify(JSON.parse(process.argv[1]).map(v=>normalizeRecordSettings({analysisCacheMiB:v}).analysisCacheMiB??p.defaultMiB)))',
            json.dumps(portable_values)], cwd=Path(__file__).resolve().parents[2],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), expected[:-2])

    def test_shared_policy_keeps_default_inside_supported_range(self):
        self.assertLessEqual(POLICY['minimumMiB'], POLICY['defaultMiB'])
        self.assertLessEqual(POLICY['defaultMiB'], POLICY['maximumMiB'])
