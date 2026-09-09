const { requestRendererFlush } = require('../close-persistence')

function registerBackendIpc({
  ipcMain,
  backendGateway,
  gameFileStore,
  getMainWindow,
  markRecordDirty,
  publishRecordDirty,
  t,
  flushRenderer = requestRendererFlush,
}) {
  const sendPythonEvent = (event) => {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python:event', event)
    }
  }

  ipcMain.handle('backend:restart', async () => {
    const fromCheckpoint = backendGateway.needsRecovery()
    if (!fromCheckpoint) {
      await flushRenderer(getMainWindow(), ipcMain, t('native.closeSaveTimeout'))
    }
    let response
    try {
      response = await backendGateway.restartBackend()
    } catch (error) {
      sendPythonEvent({
        type: 'service_recovery_failed',
        error: String(error.message || error),
      })
      throw error
    }
    if (fromCheckpoint && response.state?.gameLoaded) markRecordDirty()
    if (fromCheckpoint && !response.state?.gameLoaded) {
      gameFileStore.closeRecord()
      publishRecordDirty(true)
    }
    gameFileStore.setCurrentNodeId(response.view?.currentNodeId)
    sendPythonEvent({ type: 'service_restored', state: response.state, view: response.view })
    return response
  })
  ipcMain.handle('debug:latest-mjai', () => backendGateway.getLatestMjaiDebug())
}

module.exports = { registerBackendIpc }
