import assert from 'node:assert/strict'
import test from 'node:test'
import { decisionAnalysisFeedback } from './decisionAnalysisFeedback.ts'
import type { DecisionAnalysis } from './contracts/game.ts'

const empty: DecisionAnalysis = { model: 'test', seat: 0, discardEntries: [] }
const loaded = { profileId: 'test', ready: true, unloaded: false }
test('saved decision reads have independent readiness even with an unloaded/failed engine', () => {
  assert.deepEqual(decisionAnalysisFeedback({ ...empty, context: { dataState: 'reading' } }, true,
    'error', { ...loaded, unloaded: true }, 'engine stopped'), { pending: true, error: '' })
})
test('queued and refreshing decision results are pending; ready, disabled and failed data are not', () => {
  const row = { pai: '1m', value: .5 }
  assert.equal(decisionAnalysisFeedback({ ...empty, discardEntries: [row], context: { dataState: 'running' } },
    true, 'idle', loaded).pending, true)
  assert.equal(decisionAnalysisFeedback({ ...empty, discardEntries: [row] }, true, 'running', loaded).pending, false)
  assert.equal(decisionAnalysisFeedback(null, true, 'loading', loaded).pending, true)
  assert.equal(decisionAnalysisFeedback(null, false, 'loading', loaded).pending, false)
  assert.equal(decisionAnalysisFeedback(empty, true, 'idle', loaded).pending, false)
  assert.deepEqual(decisionAnalysisFeedback({ ...empty, error: 'decode failed' }, true, 'idle', loaded),
    { pending: false, error: 'decode failed' })
  assert.deepEqual(decisionAnalysisFeedback({ ...empty, context: { dataState: 'running' } }, true, 'error', loaded, 'inference failed'),
    { pending: false, error: 'inference failed' })
  assert.equal(decisionAnalysisFeedback({ ...empty, context: { dataState: 'running' } }, true, 'idle',
    { ...loaded, unloaded: true }).pending, false)
})
