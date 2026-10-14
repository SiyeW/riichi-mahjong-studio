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
      return { saveId: randomUUID(), target: destination, revision: store.getRevision() }
    },
    writeRecordSave: async (token, stage) => {
      calls.push('write')
      assert.equal(stage, `${token.target}.${token.saveId}.tmp`)
      fs.writeFileSync(stage, 'complete new record')
      return options.write?.(token, stage, store)
    },
    acknowledgeRecordSave: async token => { calls.push('ack'); store.markSaved(token.revision) },
    abortRecordSave: async () => { calls.push('abort') },
    ...options.gateway,
  }
  const workflow = createRecordWorkflow({ app: { getVersion: () => 'test' }, appOptions: {},
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
  await assert.rejects(workflow.saveGame(), /backend exited/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'complete new record')
  assert.equal(calls.includes('abort'), false)
})

test('external target replacement is detected before promotion', async context => {
  const { workflow, target } = fixture(context, { write: token => fs.writeFileSync(token.target, 'externally edited content') })
  fs.writeFileSync(target, 'previous')
  await assert.rejects(workflow.saveGame(), /target changed/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'externally edited content')
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
