import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, reactive, ref } from 'vue'
import type { EngineSettings } from '../contracts/engines.ts'
import type { StudioSettings } from '../contracts/settings.ts'
import { useEngineSettingsDraft } from './useEngineSettingsDraft.ts'

function engineSettings(name: string): EngineSettings {
  return {
    schemaVersion: 2,
    profiles: [{
      id: 'profile.test',
      name,
      engineId: '',
      enginePath: '',
      builtIn: false,
      available: false,
      weights: [],
      device: '',
      options: {},
    }],
    outputAssignments: {} as EngineSettings['outputAssignments'],
    loadedProfileIds: [],
  }
}

function studioSettings(name: string): StudioSettings {
  return reactive({ engines: engineSettings(name) } as StudioSettings)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('draft editing starts from persisted settings and flushes the latest snapshot', async () => {
  const settings = studioSettings('persisted')
  const settingsDraft = studioSettings('stale')
  const saved: EngineSettings[] = []
  const scope = effectScope()
  const drafts = scope.run(() => useEngineSettingsDraft({
    settings,
    settingsDraft,
    busy: ref(false),
    t: (key) => key,
    applySettings: () => {},
    save: async (engines) => {
      saved.push(structuredClone(engines))
      return studioSettings(engines.profiles[0].name)
    },
  }))!

  drafts.beginEditing()
  assert.equal(settingsDraft.engines.profiles[0].name, 'persisted')
  settingsDraft.engines.profiles[0].name = 'latest'
  assert.equal(await drafts.flush(), true)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].profiles[0].name, 'latest')
  scope.stop()
})

test('activation acknowledgements cannot replace edits made while activation is in flight', async () => {
  const settings = studioSettings('persisted')
  const settingsDraft = studioSettings('persisted')
  const pending = deferred<StudioSettings>()
  const scope = effectScope()
  const drafts = scope.run(() => useEngineSettingsDraft({
    settings,
    settingsDraft,
    busy: ref(false),
    t: (key) => key,
    applySettings: () => {},
    save: () => pending.promise,
  }))!

  drafts.beginEditing()
  settingsDraft.engines.profiles[0].name = 'activation snapshot'
  const activationRevision = drafts.currentRevision()
  settingsDraft.engines.profiles[0].name = 'newer edit'
  drafts.acknowledge(activationRevision)
  drafts.replaceIfCurrent(activationRevision, engineSettings('server reply'))
  assert.equal(settingsDraft.engines.profiles[0].name, 'newer edit')
  scope.stop()
})
