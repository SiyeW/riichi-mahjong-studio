import assert from 'node:assert/strict'
import test from 'node:test'
import { deltaHalfWidthPercent, symmetricDeltaScale } from './analysisDeltaScale.ts'

test('the kyoku delta scale keeps a symmetric 6000-point baseline', () => {
  assert.equal(symmetricDeltaScale([-800, 0, 250, 900]), 6000)
  assert.equal(deltaHalfWidthPercent(-3000, 6000), 25)
  assert.equal(deltaHalfWidthPercent(3000, 6000), 25)
})

test('either side expands the shared symmetric scale', () => {
  assert.equal(symmetricDeltaScale([-8000, 200, 900]), 8000)
  assert.equal(symmetricDeltaScale([-300, 7000, 900]), 7000)
  assert.equal(deltaHalfWidthPercent(-8000, 8000), 50)
  assert.equal(deltaHalfWidthPercent(8000, 8000), 50)
})
