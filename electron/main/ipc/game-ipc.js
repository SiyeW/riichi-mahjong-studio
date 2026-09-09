const { createRecord } = require('../state/create-record')

function registerGameIpc({
  ipcMain,
  backendGateway,
  sessionStore,
  gameFileStore,
  beginRecordTracking,
  markRecordDirty,
  publishRecordDirty,
}) {
  ipcMain.handle('status:get', () => sessionStore.getSnapshot())
  ipcMain.handle('game:view', async () => {
    const response = await backendGateway.getGameView()
    gameFileStore.setCurrentNodeId(response.view?.currentNodeId)
    return response
  })
  ipcMain.handle('game:create', () => {
    return createRecord(() => sessionStore.createGame(), gameFileStore, beginRecordTracking)
  })
  ipcMain.handle('game:close', async () => {
    const response = await backendGateway.closeGame()
    gameFileStore.closeRecord()
    publishRecordDirty(true)
    return response
  })
  ipcMain.handle('game:advance', async () => {
    const response = await backendGateway.advanceGame()
    gameFileStore.setCurrentNodeId(response.view?.currentNodeId)
    if (response.playPrefetch?.committed !== false) markRecordDirty()
    return response
  })
  ipcMain.handle('game:confirm-review', async () => {
    const response = await backendGateway.confirmPendingReview()
    gameFileStore.setCurrentNodeId(response.view?.currentNodeId)
    markRecordDirty()
    return response
  })
  ipcMain.handle('game:submit-action', async (event, action) => {
    const response = await backendGateway.submitUserAction(action)
    gameFileStore.setCurrentNodeId(response.view?.currentNodeId)
    markRecordDirty()
    return response
  })
  ipcMain.handle('game:jump-to-node', async (event, nodeId, treeRevision) => {
    const response = await backendGateway.jumpToNode(nodeId, treeRevision)
    gameFileStore.markCurrentNode(response.view?.currentNodeId)
    publishRecordDirty()
    return response
  })
  ipcMain.handle('game:set-main-branch', async (event, nodeId) => {
    const response = await backendGateway.setMainBranch(nodeId)
    markRecordDirty()
    return response
  })
  ipcMain.handle('game:set-node-comment', async (event, nodeId, comment) => {
    const response = await backendGateway.setNodeComment(nodeId, comment)
    if (response.changed) markRecordDirty()
    return response
  })
  ipcMain.handle('game:delete-node', async (event, nodeId) => {
    const response = await backendGateway.deleteNode(nodeId)
    gameFileStore.setCurrentNodeId(response.view?.currentNodeId)
    markRecordDirty()
    return response
  })
  ipcMain.handle('game:wall-view', () => backendGateway.getWallView())
  ipcMain.handle('game:reconstruct-walls', async (event, seed) => {
    const response = await backendGateway.reconstructWalls(seed)
    markRecordDirty()
    return response
  })
  ipcMain.handle('game:import-wall', async (event, tiles) => {
    const response = await backendGateway.importWall(tiles)
    gameFileStore.setCurrentNodeId(response.view?.currentNodeId)
    markRecordDirty()
    return response
  })
  ipcMain.handle('mode:set', async (event, mode) => {
    const response = await sessionStore.setMode(mode)
    markRecordDirty()
    return response
  })
  ipcMain.handle('seatSwitch:request', async (event, seat) => {
    const response = await sessionStore.requestSeatSwitch(seat)
    markRecordDirty()
    return response
  })
  ipcMain.handle('visibleHands:toggle', async () => {
    const response = await sessionStore.toggleVisibleHands()
    markRecordDirty()
    return response
  })
}

module.exports = { registerGameIpc }
