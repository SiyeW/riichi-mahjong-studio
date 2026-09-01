import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNumericPrediction } from './numericPrediction.ts'

test('preserves exact impossible and certain outcomes in discrete predictions', () => {
  const prediction = parseNumericPrediction({
    distribution: [
      { value: 0, probability: 1 },
      { value: 1, probability: 0 },
      { value: 2, probability: 0 },
    ],
  })

  assert.deepEqual(prediction.distribution, [
    { value: 0, probability: 1 },
    { value: 1, probability: 0 },
    { value: 2, probability: 0 },
  ])
  assert.equal(prediction.scalarValue, 0)
  assert.equal(prediction.scalarSource, 'distribution')
})
