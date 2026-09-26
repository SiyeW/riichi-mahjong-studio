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
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
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

  let rendererRetryTimer = null
  let rendererLoadInProgress = false
  const loadRenderer = () => {
    if (window.isDestroyed() || rendererLoadInProgress) return
    rendererLoadInProgress = true
    const load = isDev
      ? window.loadURL(rendererUrl)
      : window.loadFile(path.join(projectRoot, 'dist', 'index.html'))
    void Promise.resolve(load).catch((error) => {
      console.error('[renderer] failed to load:', error)
      scheduleRendererRetry()
    }).finally(() => { rendererLoadInProgress = false })
  }
  const scheduleRendererRetry = () => {
    if (!isDev || rendererRetryTimer !== null || window.isDestroyed()) return
    rendererRetryTimer = setTimeoutImpl(() => {
      rendererRetryTimer = null
      loadRenderer()
    }, 1000)
  }
  window.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return
    console.warn(`[renderer] load failed (${code}: ${description}) for ${validatedUrl}`)
    scheduleRendererRetry()
  })
  let windowResizeTimer = null
  let savedWindowSize = [settings.window.width, settings.window.height]
  window.on('resize', () => {
    if (windowResizeTimer !== null) clearTimeoutImpl(windowResizeTimer)
    windowResizeTimer = setTimeoutImpl(() => {
      windowResizeTimer = null
      if (window.isDestroyed()) return
      const [width, height] = window.getSize()
      if (width === savedWindowSize[0] && height === savedWindowSize[1]) return
      try {
        const latest = loadSettingsImpl(appOptions)
        latest.window = { ...latest.window, width, height }
        saveSettingsImpl(latest, appOptions)
        savedWindowSize = [width, height]
      } catch (error) {
        console.warn('[settings] failed to save window size:', error)
      }
    }, 250)
  })
  window.on('closed', () => {
    if (rendererRetryTimer !== null) clearTimeoutImpl(rendererRetryTimer)
    if (windowResizeTimer !== null) clearTimeoutImpl(windowResizeTimer)
  })
  loadRenderer()

  let closeAllowed = false
  let closeInProgress = false
  const publishCloseState = (active, stage = '') => {
    if (!window.isDestroyed()) window.webContents.send('record:close-state', { active, stage })
  }
  window.on('close', (event) => {
    if (closeAllowed) return
    event.preventDefault()
    if (closeInProgress) return
    closeInProgress = true
    publishCloseState(true, 'preparing')
    void (async () => {
      let stageStarted = performance.now()
      let activeStage = 'preparing'
      const stageChanged = (stage) => {
        console.info(`[close] ${activeStage}: ${Math.round(performance.now() - stageStarted)} ms`)
        activeStage = stage
        stageStarted = performance.now()
        publishCloseState(true, stage)
      }
      try {
        await persistBeforeCloseImpl(
          () => requestRendererFlushImpl(window, ipcMain, t('native.closeSaveTimeout'), {
            onSlow: () => stageChanged('waiting'),
          }),
          () => loadSettingsImpl(appOptions).records?.saveRecoveryOnExit && gameFileStore.isDirty(),
          () => writeRecoveryGameRecord(stageChanged),
          stageChanged,
        )
        console.info(`[close] ${activeStage}: ${Math.round(performance.now() - stageStarted)} ms`)
        closeAllowed = true
        window.close()
      } catch (error) {
        console.error(`[close] ${activeStage} failed after ${Math.round(performance.now() - stageStarted)} ms:`, error)
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
        publishCloseState(false)
      }
    })()
  })
  return window
}

module.exports = { createMainWindow, resolveZoomShortcut }
