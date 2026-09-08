import assert from 'node:assert/strict'
import test from 'node:test'
import { applyModelActivityEvent } from './modelActivityEvent.ts'

function statusFixture(): TrainerStatusSnapshot {
  return {
    modelActivity: {
      decision: ['idle', 'idle', 'idle', 'idle'],
      opponentAnalysis: 'idle',
      errors: { decision: [null, null, null, null], opponentAnalysis: null },
    },
    modelPerformance: { decision: [1, 2, 3, 4], opponentAnalysis: 5 },
    modelRuntime: {
      decision: { profileId: '', ready: false, unloaded: true },
      opponentAnalysis: { profileId: '', ready: false, unloaded: true },
    },
  } as TrainerStatusSnapshot
}

test('decision activity updates only the addressed seat and preserves opponent state', () => {
  const status = statusFixture()
  const runtime = { profileId: 'decision', ready: true, unloaded: false }
  const result = applyModelActivityEvent(status, {
    type: 'model_activity',
    model: 'decision',
    seat: 2,
    activityState: 'running',
    averageMs: 18.5,
    runtime,
  }, 'unknown')

  assert.deepEqual(result, { opponentFailed: false })
  assert.deepEqual(status.modelActivity.decision, ['idle', 'idle', 'running', 'idle'])
  assert.deepEqual(status.modelPerformance, { decision: [1, 2, 18.5, 4], opponentAnalysis: 5 })
  assert.deepEqual(status.modelRuntime.decision, runtime)
})

test('decision errors replace and clear the addressed seat error', () => {
  const status = statusFixture()
  applyModelActivityEvent(status, {
    type: 'model_activity', model: 'decision', seat: 1, activityState: 'error', error: '',
  }, 'unknown')
  assert.equal(status.modelActivity.errors?.decision[1], 'unknown')

  applyModelActivityEvent(status, {
    type: 'model_activity', model: 'decision', seat: 1, activityState: 'idle',
  }, 'unknown')
  assert.equal(status.modelActivity.errors?.decision[1], null)
})

test('opponent activity updates its runtime, timing, state, and error atomically', () => {
  const status = statusFixture()
  const runtime = { profileId: 'reader', ready: false, unloaded: false }
  const result = applyModelActivityEvent(status, {
    type: 'model_activity',
    model: 'opponent_analysis',
    activityState: 'error',
    error: 'failed',
    averageMs: 9,
    runtime,
  }, 'unknown')

  assert.deepEqual(result, { opponentFailed: true })
  assert.equal(status.modelActivity.opponentAnalysis, 'error')
  assert.equal(status.modelActivity.errors?.opponentAnalysis, 'failed')
  assert.deepEqual(status.modelPerformance, { decision: [1, 2, 3, 4], opponentAnalysis: 9 })
  assert.deepEqual(status.modelRuntime.opponentAnalysis, runtime)
})

test('invalid decision seats and unrelated events do not mutate status', () => {
  const status = statusFixture()
  const before = structuredClone(status)
  applyModelActivityEvent(status, {
    type: 'model_activity', model: 'decision', seat: 7, activityState: 'running', averageMs: 20,
  }, 'unknown')
  applyModelActivityEvent(status, { type: 'model_activity' }, 'unknown')
  assert.deepEqual(status, before)
})
