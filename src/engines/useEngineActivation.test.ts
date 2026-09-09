import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, reactive, ref } from 'vue'
import type { DesktopBridge } from '../contracts/desktopBridge.ts'
import type { EngineProfile, EngineSettings } from '../contracts/engines.ts'
import type { StudioSettings } from '../contracts/settings.ts'
import type { StudioStatus } from '../contracts/runtime.ts'
import { createEngineActivationState, useEngineActivation } from './useEngineActivation.ts'
import { useEngineSettingsDraft } from './useEngineSettingsDraft.ts'

function profile(): EngineProfile {
  return {
    id: 'profile.reader',
    name: 'Reader',
    engineId: 'engine.reader',
    enginePath: 'reader.exe',
    builtIn: false,
    available: true,
    weights: [],
    device: 'cpu',
    options: {},
  }
}

function engines(engineProfile: EngineProfile): EngineSettings {
  return {
    schemaVersion: 2,
    profiles: [engineProfile],
    outputAssignments: {
      'action-recommendation': engineProfile.id,
      'opponent-shanten': '',
      'opponent-deal-in-probability': '',
      'opponent-concealed-tile-count': '',
      'wall-tile-count': '',
      'opponent-dora-count': '',
      'opponent-score': '',
      'kyoku-outcome': '',
      'kyoku-score-delta': '',
      'match-placement': '',
      'match-score': '',
    },
    loadedProfileIds: [],
  }
}

function status(ready = false): StudioStatus {
  return {
    modelRuntime: {
      decision: { profileId: 'profile.reader', ready, unloaded: false },
      opponentAnalysis: { profileId: '', ready: false, unloaded: false },
    },
    modelActivity: {
      decision: ['idle', 'idle', 'idle', 'idle'],
      opponentAnalysis: 'idle',
      errors: { decision: [], opponentAnalysis: '' },
    },
  } as unknown as StudioStatus
}

test('activation owns the save, bridge, status, and runtime capture sequence', async () => {
  const engineProfile = profile()
  const settings = reactive({ engines: engines(engineProfile) } as StudioSettings)
  const settingsDraft = reactive({ engines: engines(structuredClone(engineProfile)) } as StudioSettings)
  const currentStatus = reactive(status())
  const activated: EngineSettings[] = []
  const bridge = {
    activateEngine: async ({ engines: snapshot }: { profileId: string; engines: EngineSettings }) => {
      activated.push(snapshot)
      return { engines: snapshot } as StudioSettings
    },
    getStatus: async () => status(true),
  } as unknown as DesktopBridge
  const scope = effectScope()
  const draft = scope.run(() => useEngineSettingsDraft({
    settings,
    settingsDraft,
    busy: ref(false),
    t: (key) => key,
    applySettings: () => {},
    save: async (snapshot) => ({ engines: snapshot }) as StudioSettings,
  }))!
  const activeProfile = ref(settingsDraft.engines.profiles[0])
  const state = createEngineActivationState()
  const activation = useEngineActivation({
    bridge: () => bridge,
    settings,
    settingsDraft,
    status: currentStatus,
    profiles: ref(settingsDraft.engines.profiles),
    activeProfile,
    opponentOutputIds: ['opponent-shanten'],
    draft,
    t: (key) => key,
    applySettings: () => {},
    applyStatus: (next) => Object.assign(currentStatus, next),
    afterOpponentUnload: () => {},
    assignedOutputs: () => ['action-recommendation'],
    loadOutputs: () => ['action-recommendation'],
    assignOutputsForLoading: () => {},
    requiredWeightsReady: () => true,
  }, state)

  await activation.load(engineProfile.id)

  assert.equal(activated.length, 1)
  assert.equal(activated[0].profiles[0].id, engineProfile.id)
  assert.equal(state.loadingProfileId.value, '')
  assert.equal(draft.message.value, 'engine.loaded')
  assert.equal(activation.profileIsLoaded(activeProfile.value), true)
  scope.stop()
})
