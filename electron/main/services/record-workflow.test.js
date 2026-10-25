const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const test = require('node:test')
const { createGameFileStore } = require('../state/game-file-store')
const { createRecordWorkflow } = require('./record-workflow')

function fixture(context, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-record-workflow-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = createGameFileStore(directory)
  store.ensureDefaultDirectory()
  store.beginRecord({ dirty: true, nodeId: 'node-1' })
  const target = path.join(directory, 'records', 'round.mjstudio')
  store.setCurrentPath(target)
  const calls = []
  const messages = []
  const gateway = {
    captureRecordSave: async (destination, version) => {
      calls.push('capture')
      assert.equal(version, 'test')
      return { saveId: randomUUID(), target: destination, revision: store.getRevision(), pathIntent: 1 }
    },
    writeRecordSave: async (token, stage) => {
      calls.push('write')
      assert.equal(stage, `${token.target}.${token.saveId}.tmp`)
      fs.writeFileSync(stage, 'complete new record')
      return options.write?.(token, stage, store)
    },
    acknowledgeRecordSave: async token => { calls.push('ack'); store.markSaved(token.revision) },
    abortRecordSave: async () => { calls.push('abort') },
    releaseRecordSave: async () => { calls.push('release') },
    ...options.gateway,
  }
  const workflow = createRecordWorkflow({ app: { getVersion: () => 'test' }, appOptions: {
    portableDir: directory, env: { RMS_BACKEND_CONFIG: path.join(directory, 'config.json') } },
    dialog: options.dialog || {}, backendGateway: gateway, gameFileStore: store,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => messages.push(args) } }),
    t: key => key })
  return { workflow, store, target, directory, calls, messages, gateway }
}

test('dirty publications are deduplicated and forced starts still publish', context => {
  const { workflow, messages } = fixture(context)
  workflow.publishRecordDirty()
  workflow.markRecordDirty()
  assert.deepEqual(messages, [['record:dirty-changed', true]])
  workflow.beginRecordTracking({ dirty: true })
  assert.equal(messages.length, 2)
})

test('save promotes a complete staging file before acknowledgement and removes staging', async context => {
  const { workflow, store, target, calls, messages } = fixture(context)
  const result = await workflow.saveGame()
  assert.deepEqual(calls, ['capture', 'write', 'ack'])
  assert.equal(fs.readFileSync(target, 'utf8'), 'complete new record')
  assert.equal(result.recordDirty, false)
  assert.equal(store.isDirty(), false)
  assert.deepEqual(messages, [['record:dirty-changed', false]])
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['round.mjstudio'])
})

test('a failed stage preserves previous data, keeps dirty and aborts only the unpromoted save', async context => {
  const { workflow, store, target, calls } = fixture(context, { write: () => { throw new Error('disk full') } })
  fs.writeFileSync(target, 'previous')
  await assert.rejects(workflow.saveGame(), /disk full/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'previous')
  assert.equal(store.isDirty(), true)
  assert.deepEqual(calls, ['capture', 'write', 'abort'])
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['round.mjstudio'])
})

test('a failed ACK never deletes the already promoted file or aborts its durable intent', async context => {
  const { workflow, target, calls } = fixture(context, { gateway: {
    acknowledgeRecordSave: async () => { calls.push('ack'); throw new Error('backend exited') },
  } })
  const saved = await workflow.saveGame()
  assert.match(saved.recoveryWarning, /backend exited/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'complete new record')
  assert.equal(calls.includes('abort'), false)
  assert.equal(calls.includes('release'), true)
})

test('external target replacement is detected before promotion', async context => {
  const { workflow, target } = fixture(context, { write: token => fs.writeFileSync(token.target, 'externally edited content') })
  fs.writeFileSync(target, 'previous')
  await assert.rejects(workflow.saveGame(), /target changed/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'externally edited content')
})

test('directory aliases cannot acquire a second save claim for the same physical target', async context => {
  let finish, entered
  const ready = new Promise(resolve => { entered = resolve })
  const { workflow, directory, target, gateway } = fixture(context, { write: () => {
    entered()
    return new Promise(resolve => { finish = resolve })
  } })
  const alias = path.join(directory, 'alias')
  try { fs.symlinkSync(path.dirname(target), alias, process.platform === 'win32' ? 'junction' : 'dir') }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return context.skip('Directory links are unavailable.'); throw error }
  const store = createGameFileStore(directory)
  store.beginRecord({ dirty: true })
  store.setCurrentPath(path.join(alias, path.basename(target)))
  const other = createRecordWorkflow({ app: { getVersion: () => 'test' }, appOptions: {}, dialog: {},
    gameFileStore: store, backendGateway: gateway, getMainWindow: () => null, t: key => key })
  const saving = workflow.saveGame()
  try {
    await ready
    await assert.rejects(other.saveGame(), /native.saveTargetBusy/)
  } finally { finish(); await saving }
})

test('an old captured save may finish its artifact but cannot change the new record path', async context => {
  const { workflow, store, target } = fixture(context, { write: (_token, _stage, recordStore) => {
    recordStore.beginRecord({ dirty: true })
    recordStore.prepareUnsavedRecord('replacement')
  } })
  await workflow.saveGame()
  assert.equal(fs.readFileSync(target, 'utf8'), 'complete new record')
  assert.equal(store.getCurrentPath(), null)
  assert.equal(store.isDirty(), true)
})

test('open starts in the portable records folder and does not change state when cancelled', async context => {
  let openOptions
  const { workflow, store, directory } = fixture(context, { dialog: {
    showOpenDialog: async (_window, options) => { openOptions = options; return { canceled: true, filePaths: [] } },
  } })
  const generation = store.getRecordGeneration()
  assert.equal(await workflow.openGame(), null)
  assert.equal(openOptions.defaultPath, path.join(directory, 'records'))
  assert.deepEqual(openOptions.filters[0].extensions, ['mjstudio', 'mjtrain', 'json'])
  assert.equal(store.getRecordGeneration(), generation)
})

test('open applies recovery metadata only after the prepared backend candidate succeeds', async context => {
  let finish
  const { workflow, store, target } = fixture(context, { dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [target] }),
  }, gateway: { importGameRecordFile: () => new Promise(resolve => { finish = resolve }) } })
  const generation = store.getRecordGeneration()
  const opening = workflow.openGame()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(store.getRecordGeneration(), generation)
  finish({ recordMetadata: { recovery: { kind: 'unsaved-exit' } },
    state: { gameLoaded: true }, view: { currentNodeId: 'new' } })
  const result = await opening
  assert.equal(result.recoveryRecord, true)
  assert.equal(result.recordDirty, true)
  assert.equal(result.view.currentNodeId, 'new')
  assert.notEqual(store.getRecordGeneration(), generation)
})

test('unclean recovery warns without waiting for a modal acknowledgement or pretending it is fully current', async context => {
  let warned = false
  const { workflow, store } = fixture(context, {
    gateway: {
      restoreRecordRecovery: async () => ({ state: { gameLoaded: true }, view: { currentNodeId: 'recovered' }, recoveryUnclean: true }),
      getRecordRuntime: () => ({ contentRevision: 2, savedContentRevision: 2, savedPath: '', recoveryWarning: 'Saved file has more data' }),
    },
    dialog: { showMessageBox: async (_window, options) => {
      assert.equal(options.type, 'warning')
      warned = true
      return new Promise(() => {})
    } },
  })
  const restored = await workflow.restoreStartupRecovery()
  assert.equal(restored.view.currentNodeId, 'recovered')
  assert.equal(warned, true)
  assert.equal(store.isDirty(), true)
})

test('legacy exit recovery is consumed once and cannot return after the recovered record is closed', async context => {
  const { workflow, store, gateway, directory } = fixture(context, { gateway: {
    restoreRecordRecovery: async () => null,
    importGameRecordFile: async () => ({ state: { gameLoaded: true, mode: 'play' }, view: { currentNodeId: 'legacy' } }),
  } })
  fs.mkdirSync(path.dirname(store.getRecoveryPath()), { recursive: true })
  fs.writeFileSync(store.getRecoveryPath(), 'legacy source remains available to its workspace')
  assert.equal((await workflow.restoreStartupRecovery()).view.currentNodeId, 'legacy')
  const freshStore = createGameFileStore(directory)
  const next = createRecordWorkflow({ app: {}, appOptions: { portableDir: directory, env: {} },
    dialog: {}, gameFileStore: freshStore, backendGateway: gateway, getMainWindow: () => null, t: key => key })
  assert.equal(await next.restoreStartupRecovery(), null)
  assert.equal(fs.readFileSync(store.getRecoveryPath(), 'utf8'), 'legacy source remains available to its workspace')
})

test('failed legacy import remains retryable and a newer workspace supersedes the old fallback', async context => {
  const { workflow, store, gateway, directory } = fixture(context, { gateway: {
    restoreRecordRecovery: async () => null,
    importGameRecordFile: async () => { throw new Error('failed import') },
  }, dialog: { showMessageBox: async () => ({ response: 0 }) } })
  fs.mkdirSync(path.dirname(store.getRecoveryPath()), { recursive: true })
  fs.writeFileSync(store.getRecoveryPath(), 'legacy')
  assert.equal(await workflow.restoreStartupRecovery(), null)
  assert.equal(createGameFileStore(directory).resolveRecoveryPathForRestore(), store.getRecoveryPath())
  gateway.restoreRecordRecovery = async () => ({ state: { gameLoaded: true }, view: { currentNodeId: 'newer' } })
  gateway.getRecordRuntime = () => ({ contentRevision: 1, savedContentRevision: 0 })
  const next = createRecordWorkflow({ app: {}, appOptions: { portableDir: directory, env: {} },
    dialog: {}, gameFileStore: createGameFileStore(directory), backendGateway: gateway, getMainWindow: () => null, t: key => key })
  assert.equal((await next.restoreStartupRecovery()).view.currentNodeId, 'newer')
  assert.equal(createGameFileStore(directory).resolveRecoveryPathForRestore(), null)
})

test('concurrent startups cannot migrate the same legacy recovery twice', async context => {
  let finish, entered
  const ready = new Promise(resolve => { entered = resolve })
  let imports = 0
  const { workflow, store, gateway, directory } = fixture(context, { gateway: {
    restoreRecordRecovery: async () => null,
    importGameRecordFile: () => {
      imports += 1
      entered()
      return new Promise(resolve => { finish = resolve })
    },
  } })
  fs.mkdirSync(path.dirname(store.getRecoveryPath()), { recursive: true })
  fs.writeFileSync(store.getRecoveryPath(), 'legacy')
  const restoring = workflow.restoreStartupRecovery()
  try {
    await ready
    const second = createRecordWorkflow({ app: {}, appOptions: { portableDir: directory, env: {} },
      dialog: {}, gameFileStore: createGameFileStore(directory), backendGateway: gateway, getMainWindow: () => null, t: key => key })
    assert.equal(await second.restoreStartupRecovery(), null)
    assert.equal(imports, 1)
  } finally {
    finish({ state: { gameLoaded: true }, view: { currentNodeId: 'legacy' } })
    await restoring
  }
})

test('failed migration bookkeeping does not hide the successfully restored record', async context => {
  let warning
  const { workflow, store } = fixture(context, { gateway: {
    restoreRecordRecovery: async () => ({ state: { gameLoaded: true }, view: { currentNodeId: 'newer' } }),
    getRecordRuntime: () => ({ contentRevision: 1, savedContentRevision: 0 }),
  }, dialog: { showMessageBox: async (_window, message) => { warning = message; return { response: 0 } } } })
  store.completeLegacyRecoveryMigration = () => { throw new Error('marker is unwritable') }
  assert.equal((await workflow.restoreStartupRecovery()).view.currentNodeId, 'newer')
  assert.match(warning.detail, /marker is unwritable/)
})
