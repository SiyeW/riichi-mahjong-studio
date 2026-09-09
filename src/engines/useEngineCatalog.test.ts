import assert from 'node:assert/strict'
import test from 'node:test'
import { reactive, ref } from 'vue'
import type { DesktopBridge } from '../contracts/desktopBridge.ts'
import type { EngineDescription, EngineProfile } from '../contracts/engines.ts'
import type { StudioSettings } from '../contracts/settings.ts'
import { useEngineCatalog } from './useEngineCatalog.ts'

const profile = {
  id: 'profile.test',
  engineId: 'engine.test',
  enginePath: 'C:\\engine.exe',
} as EngineProfile

const description = {
  engine: { id: 'engine.test', name: 'Test', version: '1.0.0' },
  outputContracts: [{ id: 'wall-tile-count' }],
  weightSlots: [{
    id: 'model',
    title: { 'zh-CN': '模型', 'en-US': 'Model' },
    formats: [],
    requiredForOutputs: [{ id: 'wall-tile-count' }],
  }],
  devices: [],
  optionsSchema: { properties: { device: { type: 'string' }, temperature: { type: 'number' } } },
} as unknown as EngineDescription

test('catalog descriptions are cached and projected into supported outputs and slots', async () => {
  let describeCalls = 0
  const bridge = {
    describeEngine: async () => { describeCalls++; return description },
  } as unknown as DesktopBridge
  const settings = reactive({ runtime: { engineCatalog: { engines: [], diagnostics: [] } } } as unknown as StudioSettings)
  const catalog = useEngineCatalog({
    bridge: () => bridge,
    settings,
    locale: ref('zh-CN'),
    t: (key) => key,
  })

  assert.deepEqual(await catalog.describe(profile), description)
  assert.deepEqual(await catalog.describe(profile), description)
  assert.equal(describeCalls, 1)
  assert.deepEqual(catalog.supportedOutputsForProfile(profile).map(({ id }) => id), ['wall-tile-count'])
  assert.deepEqual(catalog.weightSlotsForProfile(profile).map(({ id }) => id), ['model'])
  assert.equal(catalog.localizedText(description.weightSlots[0].title, ''), '模型')
  assert.deepEqual(catalog.optionEntriesForProfile(profile).map(({ key }) => key), ['temperature'])
})

test('catalog description errors remain attached to the requested engine', async () => {
  const bridge = {
    describeEngine: async () => { throw new Error('broken engine') },
  } as unknown as DesktopBridge
  const catalog = useEngineCatalog({
    bridge: () => bridge,
    settings: reactive({} as StudioSettings),
    locale: ref('en-US'),
    t: (key) => key,
  })

  assert.equal(await catalog.describe(profile), null)
  assert.equal(catalog.describeErrors[catalog.descriptionKey(profile)], 'broken engine')
  assert.equal(catalog.describingKeys.size, 0)
})
