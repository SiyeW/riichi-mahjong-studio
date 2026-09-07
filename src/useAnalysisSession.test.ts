import assert from 'node:assert/strict'
import test from 'node:test'
import { shantenResultHasRows } from './useAnalysisSession.ts'

test('analysis session recognizes protocol and legacy opponent results', () => {
  assert.equal(shantenResultHasRows({ outputs: { 'wall-tile-count': { tiles: {} } } }), true)
  assert.equal(shantenResultHasRows({ predictions: { opponents: { kamicha: [0.5, 0.5] } } }), true)
  assert.equal(shantenResultHasRows({ ground_truth: { ron_wait: { shimocha: [0.1] } } }), true)
})

test('analysis session does not fabricate rows from empty payloads', () => {
  assert.equal(shantenResultHasRows(null), false)
  assert.equal(shantenResultHasRows({}), false)
  assert.equal(shantenResultHasRows({ outputs: {}, predictions: { opponents: {} } }), false)
})
