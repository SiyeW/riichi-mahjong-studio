import assert from 'node:assert/strict'
import test from 'node:test'
import { deltaHalfWidthPercent, symmetricDeltaScale } from './analysisDeltaScale.ts'

test('the kyoku delta scale keeps a symmetric 1000-point baseline', () => {
  assert.equal(symmetricDeltaScale([-800, 0, 250, 900]), 1000)
  assert.equal(deltaHalfWidthPercent(-500, 1000), 25)
  assert.equal(deltaHalfWidthPercent(500, 1000), 25)
})

test('either side expands the shared symmetric scale', () => {
  assert.equal(symmetricDeltaScale([-1600, 200, 900]), 1600)
  assert.equal(symmetricDeltaScale([-300, 1400, 900]), 1400)
  assert.equal(deltaHalfWidthPercent(-1600, 1600), 50)
  assert.equal(deltaHalfWidthPercent(1600, 1600), 50)
})
