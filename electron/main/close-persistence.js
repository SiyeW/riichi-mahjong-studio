let requestSerial = 0

function requestRendererFlush(window, ipcMain, timeoutMessage, timeoutMs = 5000) {
  if (!window || window.isDestroyed() || window.webContents.isLoading()) return Promise.resolve()
  const contents = window.webContents
  const token = `${Date.now()}-${++requestSerial}`
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ipcMain.removeListener('record:close-ready', onReady)
      contents.removeListener('destroyed', onDestroyed)
      if (error) reject(error)
      else resolve()
    }
    const onReady = (event, receivedToken, errorMessage) => {
      if (event.sender !== contents || receivedToken !== token) return
      finish(errorMessage ? new Error(String(errorMessage)) : null)
    }
    const onDestroyed = () => finish(new Error(timeoutMessage))
    const timer = setTimeout(() => finish(new Error(timeoutMessage)), timeoutMs)
    ipcMain.on('record:close-ready', onReady)
    contents.once('destroyed', onDestroyed)
    try {
      contents.send('record:before-close', token)
    } catch (error) {
      finish(error)
    }
  })
}

async function persistBeforeClose(flushRenderer, shouldSaveRecovery, saveRecovery) {
  await flushRenderer()
  // Saving a pending comment may itself make the record dirty.
  if (shouldSaveRecovery()) await saveRecovery()
}

module.exports = { requestRendererFlush, persistBeforeClose }
