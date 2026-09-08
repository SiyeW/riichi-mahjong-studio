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
    shell: { showItemInFolder: (filePath) => calls.push(['showItemInFolder', filePath]) },
    environmentGateway: {
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
    'game:open',
    'game:restore-startup-recovery',
    'game:save',
    'game:save-as',
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
