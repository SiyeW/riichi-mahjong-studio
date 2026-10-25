import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeShantenProbabilities, pieCoordinate, shantenPieSlices } from './shantenPieGeometry.ts'

test('pie normalization preserves zeros and pads the declared category domain', () => {
  assert.deepEqual(normalizeShantenProbabilities([2, 1, -1], 5), [2 / 3, 1 / 3, 0, 0, 0])
  assert.deepEqual(normalizeShantenProbabilities([], 3), [0, 0, 0])
  assert.deepEqual(normalizeShantenProbabilities([1, 2], 0), [])
})

test('impossible slices have no moving degenerate edge; full circles remain closed', () => {
  const a = shantenPieSlices([0.2, 0, 0.8]), b = shantenPieSlices([0.7, 0, 0.3])
  assert.equal(a[1].path, 'M 0 0 Z')
  assert.equal(a[1].path, b[1].path)
  assert.equal(shantenPieSlices([1])[0].path, 'M 0 -1 A 1 1 0 1 1 0 1 A 1 1 0 1 1 0 -1 Z')
  assert.ok(a[2].path.includes('A 1 1 0 1 1'))
  assert.equal(a[1].probability, 0)
})

test('coordinate compaction bounds drawing error without rounding probabilities', () => {
  for (let index = 0; index < 500; index++) {
    const value = Math.sin(index / 7)
    const error = Math.abs(Number(pieCoordinate(value)) - value)
    assert.ok(error <= 0.000000501)
    assert.ok(error * (16000 / 6) < 0.002, 'subpixel error remains tiny on a 16K three-chart row')
  }
  assert.equal(pieCoordinate(-0.00000001), '0')
  const probability = 0.123456789012345
  const slice = shantenPieSlices([probability, 1 - probability])[0]
  assert.equal(slice.probability, probability)
  assert.ok(Math.abs(Math.hypot(slice.textX, slice.textY) - 0.62) < 1e-12)
})
