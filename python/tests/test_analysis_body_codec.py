import copy
import math
import json
from pathlib import Path
import random
import shutil
import struct
import subprocess
import unittest

from rms_backend.records.body_codec import (
    AnalysisBodyCodec, BODY_HEADER, ESCAPE64, probability_code,
)
from rms_backend.records.binary import Cursor, U64, inflate, json_bytes, load_json, unsigned
from rms_backend.riichi_score_values import possible_hand_value


def distribution(values, probabilities):
    return [{'value': value, 'probability': p} for value, p in zip(values, probabilities)]


def result_for(output, prediction):
    return {'status': 'ready', 'outputs': {output: {'players': [
        {'seat': 3, 'prediction': prediction},
    ]}}}


class AnalysisBodyCodecTests(unittest.TestCase):
    def roundtrip(self, original, **kwargs):
        codec = AnalysisBodyCodec()
        data = codec.encode(original, **kwargs)
        return AnalysisBodyCodec(copy.deepcopy(codec.schemas)).decode(data), data, codec

    def test_decision_and_unknown_semantics_stay_lossless(self):
        original = {'outputs': {'new-output': {
            '$p': {'probability': .123456789123}, 'integer': 2 ** 150,
            'missingIsNotZero': None, 'empty': [], 'true': True,
            'unicode': '牌譜🀄', 'negativeZero': -0.0,
        }}, 'a': .123456789123}
        for kind in ('decision', 'opponent'):
            actual, _, _ = self.roundtrip(original, kind=kind)
            self.assertEqual(actual, original)
            self.assertEqual(math.copysign(1, actual['outputs']['new-output']['negativeZero']), -1)
        self.assertNotIn('missing', actual)

    def test_unknown_fields_inside_recognized_output_are_not_guessed(self):
        original = result_for('opponent-dora-count', {'expectedValue': 1.23456,
            'extension': {'expectedValue': 1.23456789123,
                'distribution': [{'probability': .123456789123}]}})
        actual, _, _ = self.roundtrip(original)
        self.assertEqual(actual['outputs']['opponent-dora-count']['players'][0]['prediction']['extension'],
                         original['outputs']['opponent-dora-count']['players'][0]['prediction']['extension'])

    def test_probability_budgets_and_no_lost_support(self):
        generator = random.Random(17)
        values = [0, 1, 5e-324, 1e-300, 1e-40, .5, math.nextafter(1, 0)]
        values += [generator.random() for _ in range(1000)]
        values += [10 ** generator.uniform(-300, -1) for _ in range(400)]
        for value in values:
            with self.subTest(value=value):
                _, _, restored = probability_code(value)
                self.assertLessEqual(abs(value - restored), min(.00005, .0002 * min(value, 1 - value)))
                self.assertEqual(value == 0, restored == 0)
                self.assertEqual(value == 1, restored == 1)

    def test_sparse_zero_coordinates_and_shared_schema(self):
        codec = AnalysisBodyCodec()
        first = result_for('opponent-dora-count', {'distribution': distribution(range(8), [1] + [0] * 7)})
        second = result_for('opponent-dora-count', {'distribution': distribution(range(8), [0] * 7 + [1])})
        for value in (first, second):
            data = codec.encode(value)
            self.assertEqual(codec.decode(data), value)
            self.assertEqual(BODY_HEADER.unpack_from(data, 1)[1], 1)
        self.assertEqual(len(codec.schemas), 1)

    def test_direct_estimates_are_independent_and_js_rounding_is_used(self):
        for value in (-1000.5, -3.0005, .000001, 2200.4999):
            original = result_for('opponent-score', {
                'expectedValue': value, 'distribution': distribution([1000, 12000], [.8, .2]),
                'pointEstimate': None,
            })
            actual, _, _ = self.roundtrip(original)
            scalar = actual['outputs']['opponent-score']['players'][0]['prediction']['expectedValue']
            self.assertLessEqual(abs(scalar - value), .5)
            if value == -1000.5:
                self.assertEqual(scalar, -1000)
            if value != 0:
                self.assertNotEqual(scalar, 0)
            self.assertIsNone(actual['outputs']['opponent-score']['players'][0]['prediction']['pointEstimate'])

    def test_score_ranking_ties_escape_instead_of_reordering(self):
        probabilities = [.200001, .200002, .200003, .199997, .199997]
        original = result_for('opponent-score', {'distribution': distribution(
            [1000, 2000, 3900, 8000, 32000], probabilities)})
        actual, _, _ = self.roundtrip(original)
        restored = actual['outputs']['opponent-score']['players'][0]['prediction']['distribution']
        self.assertEqual([row['probability'] for row in restored], probabilities)

    def test_small_sum_drift_cannot_change_raw_score_mean_beyond_budget(self):
        probabilities = [.04] * 25
        original = result_for('opponent-score', {'distribution': distribution(
            [32000 * i for i in range(1, 26)], probabilities)})
        actual, _, _ = self.roundtrip(original)
        rows = actual['outputs']['opponent-score']['players'][0]['prediction']['distribution']
        self.assertEqual([row['probability'] for row in rows], probabilities)

    def test_derived_score_error_and_normalized_probabilities_have_fallback(self):
        generator = random.Random(123)
        for _ in range(50):
            probabilities = [generator.random() for _ in range(20)]
            total = sum(probabilities)
            probabilities = [p / total for p in probabilities]
            original = result_for('opponent-score', {'distribution': distribution(
                [1000 * i for i in range(1, 21)], probabilities)})
            actual, _, _ = self.roundtrip(original)
            restored = actual['outputs']['opponent-score']['players'][0]['prediction']['distribution']
            a = math.fsum(row['value'] * row['probability'] for row in original['outputs']['opponent-score']['players'][0]['prediction']['distribution'])
            b = math.fsum(row['value'] * row['probability'] for row in restored)
            self.assertLessEqual(abs(a - b), .5)

    def test_residual_order_and_large_unknown_leaves(self):
        original = {'provenance': {'text': 'long' * 40, 'value': .45678912345},
                    **result_for('opponent-dora-count', {'expectedValue': 1.1234567}),
                    'context': {'node': 'x' * 40, 'fraction': .33333333333}}
        actual, _, _ = self.roundtrip(original)
        self.assertEqual(list(actual), list(original))
        self.assertEqual(actual['provenance'], original['provenance'])
        self.assertEqual(actual['context'], original['context'])

    def test_projection_only_removed_after_exact_comparison(self):
        # Empty output has an exact empty projection; discrepancies stay lossless.
        original = {'status': 'ready', 'outputs': {}, 'predictions': {'opponents': {}, 'ron_wait': {}}}
        actual, _, codec = self.roundtrip(original, seat=0)
        self.assertEqual(actual, original)
        self.assertEqual(codec.schemas[0]['projection'], 0)
        original['predictions']['opponents']['legacy'] = [.123456789]
        actual, _, codec = self.roundtrip(original, seat=0)
        self.assertEqual(actual, original)
        self.assertIsNone(codec.schemas[0]['projection'])

    def test_broken_streams_schemas_coordinates_and_padding_rejected(self):
        original = result_for('opponent-dora-count', {'distribution': distribution([0, 1], [0, 1])})
        _, data, codec = self.roundtrip(original)
        for invalid in (b'', b'\x02', data[:-1], data + b'junk', b'\0' + U64.pack(3) + b'[] '):
            with self.subTest(data=invalid), self.assertRaises((ValueError, EOFError)):
                codec.decode(invalid)
        damaged = bytearray(data)
        damaged[1:5] = struct.pack('<I', 99)
        with self.assertRaises(ValueError):
            codec.decode(damaged)
        with self.assertRaises(ValueError):
            AnalysisBodyCodec([{'tree': ['o', [['a', ['c', 1]], ['a', ['p']]]]}])
        # One probability code has four padding bits. Nonzero padding is invalid.
        damaged = bytearray(data)
        coordinate_size = BODY_HEADER.unpack_from(data, 1)[2]
        damaged[1 + BODY_HEADER.size + coordinate_size + 2] |= 0xf0
        with self.assertRaises(ValueError):
            codec.decode(damaged)

    def test_golden_exact_body_and_varint_bounds(self):
        codec = AnalysisBodyCodec()
        self.assertEqual(codec.encode({'a': 1}, kind='decision').hex(),
                         '0007000000000000007b2261223a317d')
        self.assertEqual(Cursor(unsigned(2 ** 64 - 1)).unsigned(), 2 ** 64 - 1)
        for value in (b'\x80\0', b'\xff' * 10 + b'\0', b'\x80'):
            with self.assertRaises(ValueError):
                Cursor(value).unsigned()

    def test_dealer_filtered_score_support_and_actual_ts_formatting_parity(self):
        values = list(range(100, 100001, 100)) + [7700, 7900, 11600, 11700, 12000]
        # Native TS helpers, not another test-only translation of UI rules.
        code = '''
import {isPossibleRiichiHandValue} from './src/riichiScoring.ts';
import {createAnalysisFormatting} from './src/analysisFormatting.ts';
let data=''; for await (const chunk of process.stdin) data+=chunk;
const {values,probabilities,points}=JSON.parse(data);
const f=createAnalysisFormatting((key,p)=>String(p?.value??key),{value:'en-US'});
process.stdout.write(JSON.stringify({
  masks:[false,true].map(d=>values.map(v=>isPossibleRiichiHandValue(v,d))),
  probabilities:probabilities.map(v=>f.formatProbability(v)),
  points:points.map(v=>f.formatPlainPoints(v))
}));
'''
        payload = {'values': values, 'probabilities': [0, 1e-10, .000099, .1234, 1],
                   'points': [-1000.5, 1000.5, 7700, 7900]}
        result = subprocess.run([shutil.which('node'), '--experimental-strip-types', '--input-type=module', '-e', code],
                                input=json.dumps(payload).encode(), capture_output=True, timeout=15,
                                cwd=Path(__file__).resolve().parents[2])
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        actual = json.loads(result.stdout)
        self.assertEqual(actual['masks'], [[possible_hand_value(v, d) for v in values] for d in (False, True)])
        self.assertEqual(actual['probabilities'], ['0%', '<0.01%', '<0.01%', '12.3%', '100.0%'])
        self.assertEqual(actual['points'], ['-1000', '1001', '7700', '7900'])

    def test_compiled_schema_reused_without_rebuilding_templates(self):
        from unittest.mock import patch
        codec = AnalysisBodyCodec()
        original = result_for('opponent-dora-count', {'distribution': distribution([0, 1], [.3, .7])})
        codec.encode(original)
        original['outputs']['opponent-dora-count']['players'][0]['prediction']['distribution'][0]['probability'] = .4
        with patch('rms_backend.records.body_codec._schema_tree', side_effect=AssertionError('schema rebuilt')):
            codec.encode(original)


class BoundedRecordPrimitiveTests(unittest.TestCase):
    def test_expansion_limit_including_legacy_members(self):
        import gzip
        data = gzip.compress(b'x' * 2_000_000)
        with self.assertRaisesRegex(ValueError, 'expansion limit'):
            inflate(data, 65536)
        members = gzip.compress(b'1234') + gzip.compress(b'5678')
        self.assertEqual(inflate(members + b'\0\0', 8, members=True), b'12345678')
        with self.assertRaises(ValueError):
            inflate(members, 7, members=True)
        with self.assertRaises(ValueError):
            inflate(members, 8)
        with self.assertRaises((ValueError, EOFError)):
            inflate(data[:-1], 3_000_000)

    def test_json_limits_before_deep_parse_and_invalid_numbers(self):
        for data in (b'[' * 97 + b'0' + b']' * 97, b'{"a":NaN}', b'{"a":Infinity}', b'{"a":1e999}', b'"\xff"'):
            with self.assertRaises(ValueError):
                load_json(data)
        self.assertEqual(load_json(json_bytes({'text': '\\"[' * 200})), {'text': '\\"[' * 200})


if __name__ == '__main__':
    unittest.main()
