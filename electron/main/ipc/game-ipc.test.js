const assert = require('node:assert/strict')
const test = require('node:test')
const { registerGameIpc } = require('./game-ipc')

function createFixture(overrides = {}) {
  const handlers = new Map()
  const calls = []
  const response = (name, extra = {}) => async (...args) => {
    calls.push([name, ...args])
    return { view: { currentNodeId: `${name}-node` }, ...extra }
  }
  const backendGateway = {
    advanceGame: response('advanceGame'),
    closeGame: response('closeGame'),
    confirmPendingReview: response('confirmPendingReview'),
    deleteNode: response('deleteNode'),
    getGameView: response('getGameView'),
    getWallView: response('getWallView'),
    importWall: response('importWall'),
    jumpToNode: response('jumpToNode'),
    reconstructWalls: response('reconstructWalls'),
    setMainBranch: response('setMainBranch'),
    setNodeComment: response('setNodeComment', { changed: true }),
    submitUserAction: response('submitUserAction'),
    ...overrides.backendGateway,
  }
  const gameFileStore = {
    closeRecord: () => calls.push(['closeRecord']),
    markCurrentNode: (nodeId) => calls.push(['markCurrentNode', nodeId]),
    prepareUnsavedRecord: () => calls.push(['prepareUnsavedRecord']),
    setCurrentNodeId: (nodeId) => calls.push(['setCurrentNodeId', nodeId]),
  }
  registerGameIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    backendGateway,
    sessionStore: {
      createGame: response('createGame'),
      getSnapshot: () => ({ ready: true }),
      requestSeatSwitch: response('requestSeatSwitch'),
      setMode: response('setMode'),
      toggleVisibleHands: response('toggleVisibleHands'),
    },
    gameFileStore,
    beginRecordTracking: (value) => calls.push(['beginRecordTracking', value]),
    markRecordDirty: () => calls.push(['markRecordDirty']),
    publishRecordDirty: (force) => calls.push(['publishRecordDirty', force]),
  })
  return { calls, handlers }
}

test('game IPC registers the complete game session channel boundary', () => {
  const { handlers } = createFixture()
  assert.deepEqual([...handlers.keys()].sort(), [
    'game:advance',
    'game:close',
    'game:confirm-review',
    'game:create',
    'game:delete-node',
    'game:import-wall',
    'game:jump-to-node',
    'game:reconstruct-walls',
    'game:set-main-branch',
    'game:set-node-comment',
    'game:submit-action',
    'game:view',
    'game:wall-view',
    'mode:set',
    'seatSwitch:request',
    'status:get',
    'visibleHands:toggle',
  ])
})

test('game IPC projects game changes into record tracking without dirtying uncommitted prefetch', async () => {
  let advanceCount = 0
  const { calls, handlers } = createFixture({
    backendGateway: {
      advanceGame: async () => ({
        view: { currentNodeId: `advance-${++advanceCount}` },
        playPrefetch: { committed: advanceCount > 1 },
      }),
    },
  })

  await handlers.get('game:advance')()
  await handlers.get('game:advance')()
  await handlers.get('game:jump-to-node')(null, 'target', 7)
  await handlers.get('game:close')()

  assert.deepEqual(calls, [
    ['setCurrentNodeId', 'advance-1'],
    ['setCurrentNodeId', 'advance-2'],
    ['markRecordDirty'],
    ['jumpToNode', 'target', 7],
    ['markCurrentNode', 'jumpToNode-node'],
    ['publishRecordDirty', undefined],
    ['closeGame'],
    ['closeRecord'],
    ['publishRecordDirty', true],
  ])
})
