const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { createEngineIpcController } = require('./engine-ipc')
const { loadSettings, saveSettings } = require('../state/settings')

function createFixture(reloadEngine) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-engine-ipc-'))
  const enginePath = path.join(root, 'engine.exe')
  const weightPath = path.join(root, 'weights.pt')
  fs.writeFileSync(enginePath, '')
  fs.writeFileSync(weightPath, '')
  const appOptions = {
    appDir: root,
    portableDir: root,
    resourceDir: root,
    env: {},
    cwd: root,
    isPackaged: false,
  }
  const profile = {
    id: 'profile.test',
    name: 'Test',
    enginePath,
    engineCommand: [enginePath],
    engineCwd: root,
    engineId: 'org.test.engine',
    engineVersion: '1.0.0',
    weights: [{ slotId: 'model', format: 'pytorch', path: weightPath }],
    device: 'cpu',
    options: {},
    available: true,
  }
  const settings = loadSettings(appOptions)
  settings.engines.profiles = [profile]
  settings.engines.outputAssignments['opponent-shanten'] = profile.id
  settings.engines.loadedProfileIds = [profile.id]
  saveSettings(settings, appOptions)

  const handlers = new Map()
  const controller = createEngineIpcController({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    appOptions,
    projectRoot: root,
    environmentGateway: {
      reloadEngine,
      unloadEngine: async () => ({ state: null }),
      describeEngine: async () => ({ description: {} }),
    },
    getMainWindow: () => null,
    t: (key) => key,
  })
  controller.register()
  return { root, appOptions, controller, handlers, profile }
}

async function testRestoreDropsFailedLoadedProfile() {
  const fixture = createFixture(async () => ({
    reload: { warmed: { opponentAnalysis: false }, errors: {} },
  }))
  try {
    await fixture.controller.restoreLoadedProfiles()
    assert.deepEqual(loadSettings(fixture.appOptions).engines.loadedProfileIds, [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
}

async function testActivationDropsFailedLoadedProfile() {
  const fixture = createFixture(async () => ({
    reload: {
      warmed: { opponentAnalysis: false },
      errors: { 'opponent-analysis': 'warmup failed' },
    },
  }))
  try {
    const activate = fixture.handlers.get('engine:activate')
    const engines = loadSettings(fixture.appOptions).engines
    await assert.rejects(
      activate(null, { profileId: fixture.profile.id, engines }),
      /warmup failed/,
    )
    assert.deepEqual(loadSettings(fixture.appOptions).engines.loadedProfileIds, [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
}

async function testActivationDropsMissingWeightProfile() {
  const fixture = createFixture(async () => {
    throw new Error('reload should not run')
  })
  try {
    const activate = fixture.handlers.get('engine:activate')
    const engines = loadSettings(fixture.appOptions).engines
    engines.profiles[0].weights[0].path = path.join(fixture.root, 'missing.pt')
    await assert.rejects(
      activate(null, { profileId: fixture.profile.id, engines }),
      /native\.engine\.weightMissing/,
    )
    assert.deepEqual(loadSettings(fixture.appOptions).engines.loadedProfileIds, [])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
}

async function testActivationMarksProfileLoadedBeforeReload() {
  let fixture
  fixture = createFixture(async () => {
    assert.deepEqual(
      loadSettings(fixture.appOptions).engines.loadedProfileIds,
      [fixture.profile.id],
    )
    return {
      reload: { warmed: { opponentAnalysis: true }, errors: {} },
    }
  })
  try {
    const activate = fixture.handlers.get('engine:activate')
    const engines = loadSettings(fixture.appOptions).engines
    engines.loadedProfileIds = []
    const settings = await activate(null, { profileId: fixture.profile.id, engines })
    assert.deepEqual(settings.engines.loadedProfileIds, [fixture.profile.id])
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
}

Promise.resolve()
  .then(testRestoreDropsFailedLoadedProfile)
  .then(testActivationDropsFailedLoadedProfile)
  .then(testActivationDropsMissingWeightProfile)
  .then(testActivationMarksProfileLoadedBeforeReload)
  .then(() => console.log('engine IPC tests passed'))
