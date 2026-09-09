import assert from 'node:assert/strict'
import test from 'node:test'

import { useEngineRuntimeProfiles } from './useEngineRuntimeProfiles.ts'
import type { EngineProfile, EngineSettings } from '../contracts/engines.ts'
import type { StudioStatus } from '../contracts/runtime.ts'

function profile(): EngineProfile {
  return {
    id: 'reader',
    name: 'Reader',
    enginePath: 'reader.exe',
    weights: [],
    options: { strength: 1 },
  } as unknown as EngineProfile
}

function status(): StudioStatus {
  return {
    modelRuntime: {
      decision: { profileId: 'reader', ready: true, unloaded: false },
      opponentAnalysis: { profileId: '', ready: false, unloaded: false },
    },
    modelActivity: {
      decision: ['idle', 'idle', 'idle', 'idle'],
      opponentAnalysis: 'idle',
      errors: { decision: [], opponentAnalysis: '' },
    },
  } as unknown as StudioStatus
}

function engines(engineProfile: EngineProfile): EngineSettings {
  return {
    profiles: [engineProfile],
    outputAssignments: {
      'action-recommendation': engineProfile.id,
      'opponent-shanten': engineProfile.id,
    },
  } as EngineSettings
}

test('runtime profile matching requires an explicitly captured unchanged profile', () => {
  const engineProfile = profile()
  const runtime = useEngineRuntimeProfiles({
    status: status(),
    opponentOutputIds: ['opponent-shanten'],
    assignedOutputs: () => ['action-recommendation'],
  })

  assert.equal(runtime.profileRuntimeState(engineProfile, 'decision'), null)
  runtime.captureRuntimeEngineProfile('decision', engines(engineProfile))
  assert.deepEqual(runtime.profileRuntimeState(engineProfile, 'decision'), {
    profileId: 'reader',
    ready: true,
    unloaded: false,
  })

  engineProfile.options.strength = 2
  assert.equal(runtime.profileRuntimeState(engineProfile, 'decision'), null)
})

test('starting a configured opponent engine updates only opponent runtime activity', () => {
  const engineProfile = profile()
  const currentStatus = status()
  const runtime = useEngineRuntimeProfiles({
    status: currentStatus,
    opponentOutputIds: ['opponent-shanten'],
    assignedOutputs: () => ['opponent-shanten'],
  })

  runtime.markConfiguredEngineStarting('opponent', engines(engineProfile))

  assert.equal(currentStatus.modelRuntime.opponentAnalysis.profileId, 'reader')
  assert.equal(currentStatus.modelActivity.opponentAnalysis, 'loading')
  assert.deepEqual(currentStatus.modelActivity.decision, ['idle', 'idle', 'idle', 'idle'])
})
