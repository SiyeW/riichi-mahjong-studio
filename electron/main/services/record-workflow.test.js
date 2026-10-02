const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createGameFileStore } = require('../state/game-file-store')
const { decodeGameRecord, encodeGameRecord } = require('../state/game-record-codec')
const { createRecordWorkflow } = require('./record-workflow')

test('record dirty publication is deduplicated and forced record starts still publish', () => {
  let dirty = false
  const messages = []
  const gameFileStore = {
    beginRecord: ({ dirty: nextDirty }) => { dirty = nextDirty },
    isDirty: () => dirty,
    markDirty: () => { dirty = true },
  }
  const workflow = createRecordWorkflow({
    app: { getVersion: () => '1.0.0' },
    appOptions: {},
    dialog: {},
    backendGateway: {},
    gameFileStore,
    getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: (...args) => messages.push(args) } }),
    t: (key) => key,
  })

  assert.equal(workflow.publishRecordDirty(), false)
  assert.deepEqual(messages, [])
  workflow.markRecordDirty()
  workflow.markRecordDirty()
  assert.deepEqual(messages, [['record:dirty-changed', true]])
  workflow.beginRecordTracking({ dirty: true, nodeId: 'node' })
  assert.deepEqual(messages, [
    ['record:dirty-changed', true],
    ['record:dirty-changed', true],
  ])
})

test('saving promotes a backend staging file and tracks the saved revision', async (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-record-workflow-'))
  context.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }))

  const messages = []
  const gameFileStore = createGameFileStore(temporaryDirectory)
  const targetPath = path.join(temporaryDirectory, 'records', 'round.mjstudio')
  gameFileStore.beginRecord({ dirty: true, nodeId: 'node-1' })
  gameFileStore.setCurrentPath(targetPath)
  const workflow = createRecordWorkflow({
    app: { getVersion: () => '1.2.3' },
    appOptions: {},
    dialog: {},
    backendGateway: {
      exportGameRecordToFile: async (filePath, options) => {
        assert.notEqual(filePath, targetPath)
        assert.equal(path.dirname(filePath), path.dirname(targetPath))
        assert.deepEqual(options, { appVersion: '1.2.3', recovery: false, compressed: true })
        fs.writeFileSync(filePath, encodeGameRecord({ game: { nodes: { 'node-1': {} } } }))
        return { state: { phase: 'ready' }, view: { currentNodeId: 'node-1' } }
      },
    },
    gameFileStore,
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send: (...args) => messages.push(args) },
    }),
    t: (key) => key,
  })

  const result = await workflow.saveGame()

  assert.deepEqual(result, {
    path: targetPath,
    state: { phase: 'ready' },
    view: { currentNodeId: 'node-1' },
    recordDirty: false,
    recoveryRecord: false,
  })
  assert.equal(gameFileStore.getCurrentPath(), targetPath)
  assert.equal(gameFileStore.isDirty(), false)
  assert.deepEqual(messages, [['record:dirty-changed', false]])
  assert.deepEqual(decodeGameRecord(fs.readFileSync(targetPath)).game.nodes, { 'node-1': {} })
  assert.deepEqual(fs.readdirSync(path.dirname(targetPath)), ['round.mjstudio'])
})

test('changing record during encoding cannot mark the replacement saved', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-save-generation-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = createGameFileStore(directory)
  store.beginRecord({ dirty: true })
  const workflow = createRecordWorkflow({
    app: { getVersion: () => 'test' }, appOptions: {}, dialog: {}, gameFileStore: store,
    backendGateway: { exportGameRecordToFile: async filePath => {
      fs.writeFileSync(filePath, 'old record')
      store.beginRecord({ dirty: true })
      return {}
    } },
    getMainWindow: () => null, t: key => key,
  })
  await assert.rejects(workflow.writeRecoveryGameRecord(), /record changed/)
  assert.equal(store.isDirty(), true)
  assert.equal(fs.existsSync(store.getRecoveryPath()), false)
  assert.deepEqual(fs.readdirSync(path.dirname(store.getRecoveryPath())), [])
})

test('opening a record starts in the portable records folder', async (context) => {
  const portableDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-open-record-'))
  context.after(() => fs.rmSync(portableDirectory, { recursive: true, force: true }))
  const gameFileStore = createGameFileStore(portableDirectory)
  gameFileStore.ensureDefaultDirectory()
  let openOptions = null
  const workflow = createRecordWorkflow({
    app: { getVersion: () => '1.0.0' },
    appOptions: {},
    dialog: {
      showOpenDialog: async (_window, options) => {
        openOptions = options
        return { canceled: true, filePaths: [] }
      },
    },
    backendGateway: {},
    gameFileStore,
    getMainWindow: () => null,
    t: (key) => key,
  })

  assert.equal(await workflow.openGame(), null)
  assert.equal(openOptions.defaultPath, path.join(portableDirectory, 'records'))
  assert.deepEqual(openOptions.filters[0].extensions, ['mjstudio', 'mjtrain', 'json'])
  assert.equal(fs.existsSync(openOptions.defaultPath), true)
})

test('a failed staged save preserves the old file, dirty state, and removes partial output', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-failed-save-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = createGameFileStore(directory)
  const target = path.join(directory, 'saved.mjstudio')
  fs.writeFileSync(target, 'previous complete file')
  store.setCurrentPath(target)
  store.beginRecord({ dirty: true })
  const workflow = createRecordWorkflow({
    app: { getVersion: () => 'test' }, appOptions: {}, dialog: {}, gameFileStore: store,
    backendGateway: { exportGameRecordToFile: async filePath => {
      fs.writeFileSync(filePath, 'partial')
      throw new Error('disk full')
    } },
    getMainWindow: () => null, t: key => key,
  })
  await assert.rejects(workflow.saveGame(), /disk full/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'previous complete file')
  assert.equal(store.isDirty(), true)
  assert.deepEqual(fs.readdirSync(directory), ['saved.mjstudio'])
})

test('open waits for the backend file import before applying recovery metadata', async context => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-file-open-'))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = createGameFileStore(directory)
  store.beginRecord({ dirty: true, nodeId: 'old' })
  const generation = store.getRecordGeneration()
  const target = path.join(directory, 'recovery.mjstudio')
  let finish
  const workflow = createRecordWorkflow({
    app: {}, appOptions: {}, gameFileStore: store,
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [target] }) },
    backendGateway: { importGameRecordFile: filePath => {
      assert.equal(filePath, target)
      return new Promise(resolve => { finish = resolve })
    } },
    getMainWindow: () => null, t: key => key,
  })
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

test('exit recovery uses the same full file export without marking the record saved', async (context) => {
  const portableDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-recovery-workflow-'))
  context.after(() => fs.rmSync(portableDirectory, { recursive: true, force: true }))
  const gameFileStore = createGameFileStore(portableDirectory)
  gameFileStore.beginRecord({ dirty: true, nodeId: 'node-1' })
  const calls = []
  const workflow = createRecordWorkflow({
    app: { getVersion: () => '1.2.3' },
    appOptions: {},
    dialog: {},
    backendGateway: {
      exportGameRecordToFile: async (filePath, options) => {
        assert.equal(options.recovery, true)
        calls.push('recovery')
        fs.writeFileSync(filePath, encodeGameRecord({ metadata: {
          recovery: { kind: 'unsaved-exit', schemaVersion: 3 },
        } }))
        return {
          state: { gameLoaded: true },
          view: { currentNodeId: 'node-1' },
        }
      },
    },
    gameFileStore,
    getMainWindow: () => null,
    t: (key) => key,
  })

  const result = await workflow.writeRecoveryGameRecord()
  assert.deepEqual(calls, ['recovery'])
  assert.equal(result.path, gameFileStore.getRecoveryPath())
  assert.equal(gameFileStore.isDirty(), true)
  assert.deepEqual(decodeGameRecord(fs.readFileSync(result.path)).metadata.recovery, {
    kind: 'unsaved-exit',
    schemaVersion: 3,
  })
})
