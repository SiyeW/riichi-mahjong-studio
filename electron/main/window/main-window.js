const path = require('node:path')
const { requestRendererFlush, persistBeforeClose } = require('../close-persistence')
const { loadSettings, saveSettings } = require('../state/settings')

function resolveZoomShortcut(input) {
  if (input.type !== 'keyDown' || (!input.control && !input.meta) || input.alt) return null
  if (input.code === 'Equal' || input.code === 'NumpadAdd') return 'in'
  if (input.code === 'Minus' || input.code === 'NumpadSubtract') return 'out'
  if (input.code === 'Digit0' || input.code === 'Numpad0') return 'reset'
  return null
}

function createMainWindow({
  BrowserWindow,
  dialog,
  ipcMain,
  appOptions,
  projectRoot,
  isDev,
  rendererUrl,
  gameFileStore,
  writeRecoveryGameRecord,
  t,
  loadSettingsImpl = loadSettings,
  saveSettingsImpl = saveSettings,
  requestRendererFlushImpl = requestRendererFlush,
  persistBeforeCloseImpl = persistBeforeClose,
}) {
  const settings = loadSettingsImpl(appOptions)
  const window = new BrowserWindow({
    show: false,
    width: settings.window.width,
    height: settings.window.height,
    minWidth: 1120,
    minHeight: 760,
    backgroundColor: '#00272f',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(projectRoot, 'electron', 'preload', 'index.cjs'),
    },
  })

  window.webContents.setZoomFactor(1)
  window.webContents.on('before-input-event', (event, input) => {
    const direction = resolveZoomShortcut(input)
    if (!direction) return
    event.preventDefault()
    window.webContents.send('ui:zoom-shortcut', direction)
  })

  const showWindow = () => {
    if (window.isDestroyed() || window.isVisible()) return
    window.maximize()
    window.show()
  }
  window.once('ready-to-show', showWindow)
  window.webContents.once('did-finish-load', showWindow)

  if (isDev) void window.loadURL(rendererUrl)
  else void window.loadFile(path.join(projectRoot, 'dist', 'index.html'))

  let closeAllowed = false
  let closeInProgress = false
  window.on('close', (event) => {
    if (closeAllowed) return
    event.preventDefault()
    if (closeInProgress) return
    closeInProgress = true
    void (async () => {
      try {
        const latest = loadSettingsImpl(appOptions)
        const [width, height] = window.getSize()
        latest.window = { ...latest.window, width, height }
        saveSettingsImpl(latest, appOptions)
      } catch (error) {
        console.warn('[settings] failed to save window state during close:', error)
      }
      try {
        await persistBeforeCloseImpl(
          () => requestRendererFlushImpl(window, ipcMain, t('native.closeSaveTimeout')),
          () => loadSettingsImpl(appOptions).records?.saveRecoveryOnExit && gameFileStore.isDirty(),
          writeRecoveryGameRecord,
        )
        closeAllowed = true
        window.close()
      } catch (error) {
        console.error('[close] failed to save pending changes:', error)
        const result = await dialog.showMessageBox(window, {
          type: 'error',
          title: t('native.closeSaveFailed.title'),
          message: t('native.closeSaveFailed.message'),
          detail: error instanceof Error ? error.message : String(error),
          buttons: [t('native.cancelExit'), t('native.exitAnyway')],
          defaultId: 0,
          cancelId: 0,
        })
        if (result.response === 1) {
          closeAllowed = true
          window.close()
          return
        }
        closeInProgress = false
      }
    })()
  })
  return window
}

module.exports = { createMainWindow, resolveZoomShortcut }
