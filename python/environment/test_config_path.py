import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import service


class ConfigPathTest(unittest.TestCase):
    def setUp(self):
        self.previous_signature = service._PROJECT_CONFIG_SIGNATURE
        self.previous_value = service._PROJECT_CONFIG_VALUE

    def tearDown(self):
        service._PROJECT_CONFIG_SIGNATURE = self.previous_signature
        service._PROJECT_CONFIG_VALUE = self.previous_value

    def test_explicit_config_path_is_used_by_backend(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "debug-config.json"
            config_path.write_text(
                '{"engines":{"schemaVersion":2,"profiles":[],"outputAssignments":{"action-recommendation":"profile.debug"}}}',
                encoding="utf-8",
            )
            with mock.patch.dict(
                os.environ,
                {"MJAI_TRAINER_CONFIG": str(config_path)},
            ):
                service._PROJECT_CONFIG_SIGNATURE = None
                service._PROJECT_CONFIG_VALUE = {}

                self.assertEqual(
                    service._project_config_paths(),
                    (config_path.resolve(),),
                )
                self.assertEqual(
                    service.load_project_config()["engines"]["outputAssignments"]["action-recommendation"],
                    "profile.debug",
                )


if __name__ == "__main__":
    unittest.main()
