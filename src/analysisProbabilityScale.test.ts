import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adaptiveProbabilityScale,
  clampProbability,
  probabilityScalePercent,
  probabilityScaleRatio,
  probabilityScaleTicks,
} from './analysisProbabilityScale.ts'

test('probabilities are clamped at the protocol boundaries', () => {
  assert.equal(clampProbability(-1), 0)
  assert.equal(clampProbability(0.25), 0.25)
  assert.equal(clampProbability(2), 1)
  assert.equal(clampProbability('invalid'), 0)
})

test('adaptive scales retain the baseline until data exceeds it', () => {
  assert.equal(adaptiveProbabilityScale([0.01, 0.19]), 0.2)
  assert.equal(adaptiveProbabilityScale([0.01, 0.37]), 0.37)
})

test('scale ratios and labels share the same scale model', () => {
  assert.equal(probabilityScaleRatio(0.1, 0.2), 0.5)
  assert.equal(probabilityScalePercent(0.1, 0.2), '50.0%')
  assert.deepEqual(probabilityScaleTicks(0.2), [
    { value: 0, label: '0%' },
    { value: 0.05, label: '' },
    { value: 0.1, label: '10%' },
    { value: 0.15000000000000002, label: '' },
    { value: 0.2, label: '20%' },
  ])
})

test('tick generation stays bounded for invalid and extreme scales', () => {
  for (const scale of [NaN, Infinity, -Infinity, -1, 0, 0.999, 1, Number.MAX_VALUE]) {
    const ticks = probabilityScaleTicks(scale)
    assert.ok(ticks.length >= 1 && ticks.length <= 21)
    assert.ok(ticks.every(tick => Number.isFinite(tick.value) && tick.value >= 0 && tick.value <= 1))
  }
  assert.equal(probabilityScaleTicks(1).at(-1)?.label, '100%')
})
