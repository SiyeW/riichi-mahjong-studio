const assert = require('node:assert/strict')
const test = require('node:test')
const { downloadMortalReport, registerRecordIpc } = require('./record-ipc')

function registerFixture(overrides = {}) {
  const handlers = new Map()
  const calls = []
  const gameFileStore = {
    getCurrentPath: () => '',
    getRecordGeneration: () => 1,
    isDirty: () => true,
    prepareUnsavedRecord: (name) => calls.push(['prepareUnsavedRecord', name]),
    ...overrides.gameFileStore,
  }
  registerRecordIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: { showOpenDialog: overrides.showOpenDialog || (async () => ({ canceled: true, filePaths: [] })) },
    getMainWindow: () => null,
    shell: { showItemInFolder: (filePath) => calls.push(['showItemInFolder', filePath]) },
    backendGateway: {
      importReplayFile: async (...args) => {
        calls.push(['importReplayFile', ...args])
        if (overrides.importError) throw overrides.importError
        return { state: { loaded: true }, view: { currentNodeId: 'file-node' } }
      },
      exportCustomTenhou: async () => ({ customTenhou: 'exported' }),
      importCustomTenhou: async (...args) => {
        calls.push(['importCustomTenhou', ...args])
        return { state: { loaded: true }, view: { currentNodeId: 'custom-node' } }
      },
      importMortalReport: async (...args) => {
        calls.push(['importMortalReport', ...args])
        return { state: { loaded: true }, view: { currentNodeId: 'mortal-node' } }
      },
    },
    gameFileStore,
    beginRecordTracking: (value) => calls.push(['beginRecordTracking', value]),
    openGame: async () => 'open',
    restoreStartupRecovery: async () => 'restore',
    saveGame: async () => 'save',
    saveGameAs: async () => 'save-as',
    t: (key) => key,
    downloadReport: overrides.downloadReport,
  })
  return { calls, handlers }
}

test('record IPC registers the complete record exchange boundary', () => {
  const { handlers } = registerFixture()
  assert.deepEqual([...handlers.keys()].sort(), [
    'game:export-custom-tenhou',
    'game:import-custom-tenhou',
    'game:import-mortal-report',
    'game:import-replay-file',
    'game:open',
    'game:restore-startup-recovery',
    'game:save',
    'game:save-as',
    'game:select-import-file',
    'record:dirty-get',
    'record:show-in-folder',
  ])
})

test('custom Tenhou import establishes one dirty unsaved record', async () => {
  const { calls, handlers } = registerFixture()
  const result = await handlers.get('game:import-custom-tenhou')(null, {
    input: 'log',
    reconstructWalls: true,
    seed: 17,
  })

  assert.deepEqual(calls, [
    ['importCustomTenhou', 'log', { reconstructWalls: true, seed: 17 }],
    ['prepareUnsavedRecord', 'custom-tenhou'],
    ['beginRecordTracking', { dirty: true, nodeId: 'custom-node' }],
  ])
  assert.deepEqual(result, {
    reconstruction: null,
    state: { loaded: true },
    view: { currentNodeId: 'custom-node' },
    recordDirty: true,
  })
})

test('replay picker cancellation does not alter the active record', async () => {
  const { calls, handlers } = registerFixture()
  assert.equal(await handlers.get('game:select-import-file')(), null)
  assert.deepEqual(calls, [])
})

test('replay file path is delegated to the backend before marking a new record', async () => {
  const { calls, handlers } = registerFixture()
  const request = { path: 'D:\\arena\\match.json.gz', reconstructWalls: true, seed: 17 }
  const result = await handlers.get('game:import-replay-file')(null, request)
  assert.deepEqual(calls, [
    ['importReplayFile', request.path, request],
    ['prepareUnsavedRecord', 'match'],
    ['beginRecordTracking', { dirty: true, nodeId: 'file-node' }],
  ])
  assert.equal(result.recordDirty, true)
  assert.equal(result.view.currentNodeId, 'file-node')
})

test('failed replay imports do not replace record tracking', async () => {
  const { calls, handlers } = registerFixture({ importError: new Error('invalid replay') })
  await assert.rejects(handlers.get('game:import-replay-file')(null, { path: 'bad.gz' }), /invalid replay/)
  assert.equal(calls.length, 1)
  await assert.rejects(handlers.get('game:import-replay-file')(null, {}), /path/)
})

test('Mortal report download validates and returns the normalized report', async () => {
  const requests = []
  const result = await downloadMortalReport('96113a5b9f2e286b', {
    fetchImpl: async (...args) => {
      requests.push(args)
      return new Response(JSON.stringify({ mjai_log: [{ type: 'start_game' }] }))
    },
    t: (key) => key,
  })

  assert.equal(result.sourceUrl, 'https://mjai.ekyu.moe/report/96113a5b9f2e286b.json')
  assert.deepEqual(result.report, { mjai_log: [{ type: 'start_game' }] })
  assert.equal(requests.length, 1)
  assert.equal(requests[0][0], result.sourceUrl)
  assert.equal(requests[0][1].headers.Accept, 'application/json')
})
