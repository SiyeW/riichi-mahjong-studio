const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { createGameFileStore } = require('../state/game-file-store')
const { decodeGameRecord } = require('../state/game-record-codec')
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

test('saving owns record export, encoding, path tracking, and dirty publication', async (context) => {
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
      exportGameRecord: async () => ({
        record: {
          metadata: { models: ['private'], source: 'test' },
          nodes: [{ id: 'node-1' }],
        },
        state: { phase: 'ready' },
        view: { currentNodeId: 'node-1' },
      }),
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
  assert.deepEqual(decodeGameRecord(fs.readFileSync(targetPath)), {
    metadata: { source: 'test', appVersion: '1.2.3' },
    nodes: [{ id: 'node-1' }],
  })
})
