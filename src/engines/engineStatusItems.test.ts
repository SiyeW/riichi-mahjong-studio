import assert from 'node:assert/strict'
import test from 'node:test'

import { buildEngineStatusItems, normalizeModelActivityState } from './engineStatusItems.ts'
import type { EngineProfile } from '../contracts/engines.ts'
import type { StudioStatus } from '../contracts/runtime.ts'

const profile = { id: 'engine-1', name: 'Reader' } as EngineProfile
const t = (key: string, params?: Record<string, string | number>) => {
  if (key === 'common.listSeparator') return ', '
  if (key === 'status.recentAverage') return `${params?.engine} ${params?.value}ms`
  if (key === 'common.unnamedEngine') return 'Unnamed'
  return key.replace('seat.', '')
}

test('model activity normalization accepts protocol states and legacy booleans', () => {
  assert.equal(normalizeModelActivityState('loading'), 'loading')
  assert.equal(normalizeModelActivityState(true), 'running')
  assert.equal(normalizeModelActivityState(false), 'idle')
  assert.equal(normalizeModelActivityState('unexpected'), 'idle')
})

test('engine status projection omits inactive profiles', () => {
  const items = buildEngineStatusItems({
    profiles: [profile],
    status: { controlledSeat: 0 } as StudioStatus,
    loadingProfileId: '',
    loadErrors: {},
    runtimeState: () => null,
    runtimeKinds: () => [],
    t,
  })

  assert.deepEqual(items, [])
})

test('engine status projection combines opponent timing and errors with error priority', () => {
  const status = {
    controlledSeat: 0,
    modelActivity: {
      decision: ['idle', 'idle', 'idle', 'idle'],
      opponentAnalysis: 'running',
      errors: { decision: [], opponentAnalysis: 'model failed' },
    },
    modelPerformance: { decision: [0, 0, 0, 0], opponentAnalysis: 12.5 },
  } as unknown as StudioStatus

  const items = buildEngineStatusItems({
    profiles: [profile],
    status,
    loadingProfileId: '',
    loadErrors: {},
    runtimeState: (_profile, kind) => kind === 'opponent' ? { ready: true, unloaded: false } : null,
    runtimeKinds: () => ['opponent'],
    t,
  })

  assert.deepEqual(items, [{ id: 'engine-1', label: 'Reader：model failed', state: 'error' }])
})

test('engine status label stays stable while automatic analysis moves between seats', () => {
  const buildItems = (decision: string[]) => buildEngineStatusItems({
    profiles: [profile],
    status: {
      controlledSeat: 0,
      modelActivity: {
        decision,
        opponentAnalysis: 'idle',
        errors: { decision: [null, null, null, null], opponentAnalysis: null },
      },
      modelPerformance: { decision: [12, 14, 16, 18], opponentAnalysis: 0 },
    } as unknown as StudioStatus,
    loadingProfileId: '',
    loadErrors: {},
    runtimeState: (_profile, kind) => kind === 'decision' ? { ready: true, unloaded: false } : null,
    runtimeKinds: () => ['decision'],
    t,
  })

  const ownSeat = buildItems(['running', 'idle', 'idle', 'idle'])
  const oppositeSeat = buildItems(['idle', 'idle', 'running', 'idle'])

  assert.deepEqual(ownSeat, [{ id: 'engine-1', label: 'Reader 15.0ms', state: 'running' }])
  assert.deepEqual(oppositeSeat, ownSeat)
})
