import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptsAnalysisEpoch } from './analysisEpoch.ts'

test('before an explicit cache reset, results need no epoch barrier', () => {
  assert.equal(acceptsAnalysisEpoch(undefined, null), true)
  assert.equal(acceptsAnalysisEpoch(0, null), true)
})

test('after reset, old or unidentifiable batches are rejected', () => {
  for (const value of [undefined, null, '2', 0, 1, 2.5, NaN, Infinity]) {
    assert.equal(acceptsAnalysisEpoch(value, 2), false)
  }
  assert.equal(acceptsAnalysisEpoch(2, 2), true)
  assert.equal(acceptsAnalysisEpoch(3, 2), true)
})
