import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from rms_backend import service


class ConfigPathTest(unittest.TestCase):
    def setUp(self):
        self.previous_signature = service.ENGINE_MANAGEMENT._project_config_signature
        self.previous_value = service.ENGINE_MANAGEMENT._project_config_value

    def tearDown(self):
        service.ENGINE_MANAGEMENT._project_config_signature = self.previous_signature
        service.ENGINE_MANAGEMENT._project_config_value = self.previous_value

    def test_current_config_path_is_used_by_backend(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            config_path = Path(temp_dir) / "debug-config.json"
            config_path.write_text(
                '{"engines":{"schemaVersion":2,"profiles":[],"outputAssignments":{"action-recommendation":"profile.debug"}}}',
                encoding="utf-8",
            )
            with mock.patch.dict(
                os.environ,
                {"RMS_BACKEND_CONFIG": str(config_path)},
                clear=True,
            ):
                service.ENGINE_MANAGEMENT.reset_project_config_cache()

                self.assertEqual(
                    service.ENGINE_MANAGEMENT.project_config_paths(),
                    (config_path.resolve(),),
                )
                self.assertEqual(
                    service.ENGINE_MANAGEMENT.load_project_config()["engines"]["outputAssignments"]["action-recommendation"],
                    "profile.debug",
                )

    def test_current_config_path_takes_priority_and_legacy_name_remains_compatible(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            current_path = Path(temp_dir) / "current.json"
            legacy_path = Path(temp_dir) / "legacy.json"
            with mock.patch.dict(
                os.environ,
                {
                    "RMS_BACKEND_CONFIG": str(current_path),
                    "MJAI_TRAINER_CONFIG": str(legacy_path),
                },
                clear=True,
            ):
                self.assertEqual(service.ENGINE_MANAGEMENT.project_config_paths(), (current_path.resolve(),))
            with mock.patch.dict(
                os.environ,
                {"MJAI_TRAINER_CONFIG": str(legacy_path)},
                clear=True,
            ):
                self.assertEqual(service.ENGINE_MANAGEMENT.project_config_paths(), (legacy_path.resolve(),))

    def test_current_portable_root_takes_priority_and_legacy_name_remains_compatible(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            current_path = root / "current"
            legacy_path = root / "legacy"
            self.assertEqual(
                service.resolve_portable_root(
                    {
                        "RMS_PORTABLE_DIR": str(current_path),
                        "MJAI_TRAINER_PORTABLE_DIR": str(legacy_path),
                    },
                    root,
                ),
                current_path.resolve(),
            )
            self.assertEqual(
                service.resolve_portable_root(
                    {"MJAI_TRAINER_PORTABLE_DIR": str(legacy_path)},
                    root,
                ),
                legacy_path.resolve(),
            )


if __name__ == "__main__":
    unittest.main()
