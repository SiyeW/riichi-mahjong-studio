import copy
import gzip
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

from rms_backend import service
from rms_backend.record_file import read_record_file, RecordFileWriter
from rms_backend.record_session import RecordSession


class RecordFileTests(unittest.TestCase):
    def test_pending_export_retains_its_owners_after_the_record_is_closed(self):
        game = service.create_empty_game(123456)
        state = {
            'game': game, 'gameLoaded': True, 'mode': 'research',
            'controlledSeat': 0, 'pendingSeatSwitch': None, 'visibleHands': True,
        }
        session = RecordSession(state, SimpleNamespace(reset_runtime=lambda: None))
        prepared = session.prepare_export()
        session.close()
        self.assertIsNot(prepared.file_writer, session._file_writer)
        self.assertIsNot(prepared.analysis_packer, session._analysis_packer)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'pending.tmp'
            prepared.file_writer.write(path, session.serialize_prepared_export(prepared))
            self.assertEqual(read_record_file(path)['game']['gameId'], game['gameId'])
        self.assertFalse(state['gameLoaded'])

    def test_unchanged_analysis_is_compressed_once_but_edits_always_reach_disk(self):
        writer = RecordFileWriter()
        record = {'game': {'comment': 'first'}, 'analysisCacheStorage': {'payload': [0, 0.25, 1]}}
        with tempfile.TemporaryDirectory() as directory, \
             patch('rms_backend.record_file.gzip.compress', wraps=gzip.compress) as compress:
            first = Path(directory) / 'first.tmp'
            writer.write(first, record)
            self.assertEqual(compress.call_count, 3)
            record['game']['comment'] = 'second'
            second = Path(directory) / 'second.tmp'
            writer.write(second, record, recovery=True)
            self.assertEqual(compress.call_count, 5)
            self.assertEqual(read_record_file(second)['game']['comment'], 'second')
            self.assertEqual(read_record_file(first)['game']['comment'], 'first')
            record['analysisCacheStorage'] = {'payload': [1, 0, 0]}
            third = Path(directory) / 'third.tmp'
            writer.write(third, record)
            self.assertEqual(compress.call_count, 8)
            self.assertEqual(read_record_file(third)['analysisCacheStorage']['payload'], [1, 0, 0])

    def test_plain_compressed_and_bom_preserve_authored_text(self):
        record = {"comment": "评论・牌譜🀄・�"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "记录.mjstudio"
            for bom in ("", "\ufeff"):
                data = (bom + json.dumps(record, ensure_ascii=False)).encode("utf-8")
                for encoded in (data, gzip.compress(data)):
                    path.write_bytes(encoded)
                    self.assertEqual(read_record_file(path), record)

    def test_damaged_input_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.mjstudio"
            for data in (b'{"x":"\xff"}', b'{"x":', gzip.compress(b'{}')[:-4]):
                path.write_bytes(data)
                with self.assertRaises((ValueError, EOFError)):
                    read_record_file(path)

    def test_metadata_is_portable_and_existing_files_are_never_overwritten(self):
        record = {"game": {}, "metadata": {
            "models": {"modelPath": "private"}, "app": "old", "recordType": "old",
            "source": "test", "recovery": {"sourcePath": "private"},
        }}
        original = copy.deepcopy(record)
        with tempfile.TemporaryDirectory() as directory:
            for recovery in (False, True):
                for compressed in (False, True):
                    path = Path(directory) / f"{recovery}-{compressed}.tmp"
                    RecordFileWriter().write(path, record, recovery=recovery,
                                      compressed=compressed, app_version="1.2.3")
                    expected = {"source": "test", "appVersion": "1.2.3"}
                    if recovery:
                        expected["recovery"] = {"kind": "unsaved-exit", "schemaVersion": 3}
                    self.assertEqual(read_record_file(path)["metadata"], expected)
                    with self.assertRaises(FileExistsError):
                        RecordFileWriter().write(path, {})
                    self.assertEqual(read_record_file(path)["game"], {})
        self.assertEqual(record, original)

    def test_file_export_returns_no_bulk_record_and_fsyncs_before_completion(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "staging.tmp"
            with patch.object(service.RECORD_SESSION, "prepare_export", return_value=SimpleNamespace(file_writer=RecordFileWriter())), \
                 patch.object(service.RECORD_SESSION, "serialize_prepared_export", return_value={"game": {}}), \
                 patch.object(service.VIEW_BUILDER, "build_response", return_value={"view": {}}), \
                 patch("rms_backend.record_file.os.fsync") as sync:
                result = service._export_game_record(1, "export_game_record", {"path": str(path)})
            sync.assert_called_once()
            self.assertNotIn("record", result)
            self.assertEqual(read_record_file(path)["game"], {})


if __name__ == '__main__':
    unittest.main()
