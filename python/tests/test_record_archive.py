import copy
import gc
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from rms_backend.records.body_codec import AnalysisBodyCodec
from rms_backend.records.archive import (
    ArchiveSource, HEADER, MAGIC, PortableBody, read_archive, write_archive,
)
from rms_backend.records.binary import U64, inflate, json_bytes


class RecordArchiveTests(unittest.TestCase):
    def fixture(self):
        codec = AnalysisBodyCodec()
        results = [
            {'status': 'ready', 'error': None, 'outputs': {'opponent-dora-count': {
                'players': [{'seat': 3, 'prediction': {'expectedValue': 1.23456,
                    'distribution': [{'value': 0, 'probability': 0}, {'value': 1, 'probability': 1}]}}],
            }}},
            {'status': 'ready', 'outputs': {'unknown': {'data': '牌譜' * 20, 'integer': 2 ** 100}}},
        ]
        bodies = [PortableBody.from_bytes(gzip.compress(codec.encode(result), compresslevel=3, mtime=0)) for result in results]
        entries = [{'node': str(index), 'field': 'opponentAnalysisCache', 'key': 'o5::0::public::test',
                    'body': index % 2, 'fields': {
                        key: [not isinstance(value, (dict, list)), value if not isinstance(value, (dict, list)) else None]
                        for key, value in results[index % 2].items()
                    }} for index in range(40)]
        record = {'formatVersion': 3, 'game': {'nodes': {str(i): {'comment': f'注釈 {i}'} for i in range(40)}}}
        canonical = [codec.decode(inflate(next(body.chunks()), 32 * 1024 * 1024)) for body in bodies]
        return record, entries, codec.schemas, bodies, canonical

    def test_open_reads_no_bodies_direct_jump_and_cross_runtime_parity(self):
        record, entries, schemas, bodies, expected = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / '记录.mjstudio'
            identity = write_archive(path, record, entries, schemas, bodies)
            with patch.object(ArchiveSource, 'read_body', side_effect=AssertionError('eager body read')):
                archive = read_archive(path.open('rb'))
            self.assertEqual(identity, archive.source.identity)
            self.assertEqual(archive.record, record)
            self.assertEqual(archive.decode_entry(39), expected[1])
            code = "const fs=require('node:fs'); const {decodeGameRecord}=require('./electron/main/state/game-record-codec'); process.stdout.write(JSON.stringify(decodeGameRecord(fs.readFileSync(process.argv[1]))))"
            result = subprocess.run([shutil.which('node'), '-e', code, str(path)],
                                    cwd=Path(__file__).resolve().parents[2], capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            actual = json.loads(result.stdout)
            for index in range(40):
                self.assertEqual(actual['game']['nodes'][str(index)]['opponentAnalysisCache']['o5::0::public::test'], expected[index % 2])
            del archive
            gc.collect()

    def test_rewrite_copies_encoded_providers_without_decoding_and_does_not_overwrite(self):
        record, entries, schemas, bodies, expected = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            path, saved = Path(directory) / 'old', Path(directory) / 'saved'
            write_archive(path, record, entries, schemas, bodies)
            archive = read_archive(path.open('rb'))
            original_hash = hashlib.sha256(path.read_bytes()).digest()
            with (patch.object(AnalysisBodyCodec, 'encode', side_effect=AssertionError('reencoded')),
                  patch.object(AnalysisBodyCodec, 'decode', side_effect=AssertionError('decoded'))):
                changed = copy.deepcopy(record)
                changed['game']['nodes']['1']['comment'] = 'edited'
                write_archive(saved, changed, entries, schemas,
                              [PortableBody.from_source(archive.source, i) for i in range(2)])
            self.assertEqual(hashlib.sha256(path.read_bytes()).digest(), original_hash)
            reopened = read_archive(saved.open('rb'))
            self.assertEqual(reopened.record['game']['nodes']['1']['comment'], 'edited')
            self.assertEqual(reopened.decode_entry(0), expected[0])
            with self.assertRaises(FileExistsError):
                write_archive(saved, record, entries, schemas, bodies)
            del archive, reopened
            gc.collect()

    def test_detach_releases_original_path_but_keeps_captured_bytes(self):
        record, entries, schemas, bodies, expected = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'old'
            write_archive(path, record, entries, schemas, bodies)
            archive = read_archive(path.open('rb'))
            archive.source.detach()
            replacement = Path(directory) / 'replacement'
            replacement.write_bytes(b'other generation')
            replacement.replace(path)
            self.assertEqual(archive.decode_entry(0), expected[0])
            del archive
            gc.collect()

    def test_body_damage_stays_local_and_blocks_complete_copy(self):
        record, entries, schemas, bodies, expected = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'damaged'
            write_archive(path, record, entries, schemas, bodies)
            data = bytearray(path.read_bytes())
            data[-1] ^= 1
            path.write_bytes(data)
            archive = read_archive(path.open('rb'))
            self.assertEqual(archive.decode_entry(0), expected[0])
            with self.assertRaisesRegex(ValueError, 'Damaged'):
                archive.decode_entry(1)
            with self.assertRaisesRegex(ValueError, 'Damaged'):
                write_archive(Path(directory) / 'failed-staging', record, entries, schemas,
                              [PortableBody.from_source(archive.source, i) for i in range(2)])
            incomplete = Path(directory) / 'incomplete-base'
            with self.assertRaisesRegex(ValueError, 'Damaged'):
                archive.source.detach(incomplete)
            self.assertFalse(incomplete.exists())
            self.assertFalse(archive.source.detached)
            del archive
            gc.collect()

    def test_invalid_directory_schema_or_bounds_reject_candidate_and_close_source(self):
        record, entries, schemas, bodies, _ = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bad'
            write_archive(path, record, entries, schemas, bodies)
            original = path.read_bytes()
            length = HEADER.unpack_from(original)[1]
            raw = inflate(original[16:16 + length], 64 * 1024 * 1024)
            manifest_length = U64.unpack_from(raw)[0]
            manifest = json.loads(raw[8:8 + manifest_length])
            for kind in ('missing-node', 'bad-body', 'duplicate-slot', 'bad-schema', 'bad-table'):
                broken = copy.deepcopy(manifest)
                table = raw[8 + manifest_length:]
                if kind == 'missing-node': broken['entries'][0]['node'] = 'missing'
                elif kind == 'bad-body': broken['entries'][0]['body'] = True
                elif kind == 'duplicate-slot': broken['entries'].append(broken['entries'][0])
                elif kind == 'bad-schema': broken['schemas'][0]['tree'] = ['execute', 'anything']
                elif kind == 'bad-table': table = table[:-1]
                metadata = json_bytes(broken)
                directory_bytes = gzip.compress(U64.pack(len(metadata)) + metadata + table)
                path.write_bytes(HEADER.pack(MAGIC, len(directory_bytes)) + directory_bytes + original[16 + length:])
                file = path.open('rb')
                with self.subTest(kind=kind), self.assertRaises(ValueError):
                    read_archive(file)
                self.assertTrue(file.closed)


if __name__ == '__main__':
    unittest.main()
