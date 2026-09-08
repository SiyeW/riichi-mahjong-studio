const assert = require('node:assert/strict')
const test = require('node:test')
const { registerEnvironmentIpc } = require('./environment-ipc')

function createFixture({ needsRecovery = false, restartBackend } = {}) {
  const handlers = new Map()
  const calls = []
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) }
  const window = {
    isDestroyed: () => false,
    webContents: { send: (...args) => calls.push(['send', ...args]) },
  }
  registerEnvironmentIpc({
    ipcMain,
    environmentGateway: {
      getLatestMjaiDebug: () => 'debug',
      needsRecovery: () => needsRecovery,
      restartBackend: restartBackend || (async () => ({
        state: { gameLoaded: true },
        view: { currentNodeId: 'restored-node' },
      })),
    },
    gameFileStore: {
      closeRecord: () => calls.push(['closeRecord']),
      setCurrentNodeId: (nodeId) => calls.push(['setCurrentNodeId', nodeId]),
    },
    getMainWindow: () => window,
    markRecordDirty: () => calls.push(['markRecordDirty']),
    publishRecordDirty: (force) => calls.push(['publishRecordDirty', force]),
    t: (key) => key,
    flushRenderer: async (...args) => calls.push(['flushRenderer', ...args]),
  })
  return { calls, handlers, ipcMain, window }
}

test('environment IPC registers restart and debug channels', () => {
  const { handlers } = createFixture()
  assert.deepEqual([...handlers.keys()].sort(), ['backend:restart', 'debug:latest-mjai'])
  assert.equal(handlers.get('debug:latest-mjai')(), 'debug')
})

test('ordinary restart flushes pending renderer edits before restoring the session', async () => {
  const { calls, handlers, ipcMain, window } = createFixture()
  const response = await handlers.get('backend:restart')()

  assert.deepEqual(response.state, { gameLoaded: true })
  assert.deepEqual(calls, [
    ['flushRenderer', window, ipcMain, 'native.closeSaveTimeout'],
    ['setCurrentNodeId', 'restored-node'],
    ['send', 'python:event', {
      type: 'service_restored',
      state: { gameLoaded: true },
      view: { currentNodeId: 'restored-node' },
    }],
  ])
})

test('checkpoint recovery marks a restored game dirty without flushing the dead renderer state', async () => {
  const { calls, handlers } = createFixture({ needsRecovery: true })
  await handlers.get('backend:restart')()

  assert.deepEqual(calls, [
    ['markRecordDirty'],
    ['setCurrentNodeId', 'restored-node'],
    ['send', 'python:event', {
      type: 'service_restored',
      state: { gameLoaded: true },
      view: { currentNodeId: 'restored-node' },
    }],
  ])
})

test('checkpoint recovery without a game closes record tracking and publishes the clean state', async () => {
  const { calls, handlers } = createFixture({
    needsRecovery: true,
    restartBackend: async () => ({ state: { gameLoaded: false }, view: null }),
  })
  await handlers.get('backend:restart')()

  assert.deepEqual(calls, [
    ['closeRecord'],
    ['publishRecordDirty', true],
    ['setCurrentNodeId', undefined],
    ['send', 'python:event', {
      type: 'service_restored',
      state: { gameLoaded: false },
      view: null,
    }],
  ])
})

test('failed recovery publishes the failure event and preserves the rejection', async () => {
  const failure = new Error('restart failed')
  const { calls, handlers } = createFixture({
    needsRecovery: true,
    restartBackend: async () => { throw failure },
  })

  await assert.rejects(handlers.get('backend:restart')(), failure)
  assert.deepEqual(calls, [[
    'send',
    'python:event',
    { type: 'service_recovery_failed', error: 'restart failed' },
  ]])
})
