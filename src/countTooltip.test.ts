import assert from 'node:assert/strict'
import test from 'node:test'
import { countTooltipDistribution } from './countTooltip.ts'

const palette = ['rgb(20, 72, 81)', '#37647b', '#2c8fc5', '#73bbda', '#b6dce9']

test('count detail keeps the five outcomes in one complete distribution', () => {
  const entries = countTooltipDistribution([
    { value: 2, probability: 0.3 },
    { value: 0, probability: 0.6 },
    { value: 1, probability: 0.1 },
  ], false, palette)
  assert.deepEqual(entries.map((entry) => entry.count), [0, 1, 2, 3, 4])
  assert.ok(Math.abs(entries.reduce((sum, entry) => sum + entry.probability, 0) - 1) < 1e-12)
  assert.deepEqual(entries.map((entry) => entry.color), palette)
  assert.equal(entries[3].probability, 0)
  assert.equal(entries[4].probability, 0)
})

test('red-five detail uses two outcomes and the actual one-tile color', () => {
  const entries = countTooltipDistribution([
    { value: 0, probability: 0.75 },
    { value: 1, probability: 0.25 },
  ], true, palette)
  assert.deepEqual(entries, [
    { count: 0, probability: 0.75, color: palette[0] },
    { count: 1, probability: 0.25, color: palette[1] },
  ])
})

test('count detail preserves exact impossible and certain outcomes', () => {
  const entries = countTooltipDistribution([
    { value: 0, probability: 0 },
    { value: 1, probability: 1 },
    { value: 2, probability: 0 },
    { value: 3, probability: 0 },
    { value: 4, probability: 0 },
  ], false, palette)

  assert.deepEqual(entries.map((entry) => entry.probability), [0, 1, 0, 0, 0])
})

test('missing and empty distributions never become a fabricated zero-tile prediction', () => {
  assert.deepEqual(countTooltipDistribution([], false, palette), [])
  assert.deepEqual(countTooltipDistribution([{ value: 0, probability: 0 }], false, palette), [])
})
