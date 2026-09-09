import assert from 'node:assert/strict'
import test from 'node:test'
import { analysisResultHasRows } from './useAnalysisSession.ts'

test('analysis session recognizes protocol and legacy opponent results', () => {
  assert.equal(analysisResultHasRows({ outputs: { 'wall-tile-count': { tiles: {} } } }), true)
  assert.equal(analysisResultHasRows({ predictions: { opponents: { kamicha: [0.5, 0.5] } } }), true)
  assert.equal(analysisResultHasRows({ ground_truth: { ron_wait: { shimocha: [0.1] } } }), true)
})

test('analysis session does not fabricate rows from empty payloads', () => {
  assert.equal(analysisResultHasRows(null), false)
  assert.equal(analysisResultHasRows({}), false)
  assert.equal(analysisResultHasRows({ outputs: {}, predictions: { opponents: {} } }), false)
})
