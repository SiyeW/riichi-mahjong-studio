const path = require('node:path')
const fs = require('node:fs')
const { requestRendererFlush, persistBeforeClose } = require('./close-persistence')
const { pathToFileURL } = require('node:url')

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
} = require('electron')
const { registerApplicationIpc } = require('./ipc/application-ipc')
const { registerAnalysisIpc } = require('./ipc/analysis-ipc')
const { createEngineIpcController } = require('./ipc/engine-ipc')
const { registerGameIpc } = require('./ipc/game-ipc')
const { registerSettingsIpc } = require('./ipc/settings-ipc')
const { createEnvironmentService } = require('./services/environment-service')
const { createRecordWorkflow } = require('./services/record-workflow')
const { withCurrentRecord } = require('./state/record-operation')
const { readLimitedResponseText } = require('./services/limited-response')
const { buildRuntimeMetrics } = require('./runtime-metrics')
const { loadSettings, saveSettings } = require('./state/settings')
const { discoverSoundPacks, resolveSoundPackFile } = require('./state/sound-pack-registry')
const { createSessionStore } = require('./state/session-store')
const {
  createGameFileStore,
} = require('./state/game-file-store')
const { normalizeMortalReportUrl } = require('./mortal-report-url')
const { createTranslator } = require('./i18n')

const projectRoot = path.resolve(__dirname, '..', '..')
const isDev = !app.isPackaged
const rendererUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173'
const portableRoot = app.isPackaged ? path.dirname(process.execPath) : projectRoot
const resourceRoot = app.isPackaged ? process.resourcesPath : projectRoot

const appOptions = {
  appVersion: app.getVersion(),
  appDir: projectRoot,
  resourceDir: resourceRoot,
  portableDir: portableRoot,
  env: process.env,
  cwd: process.cwd(),
  isPackaged: app.isPackaged,
  execPath: process.execPath,
}

const t = createTranslator({
  getPreference: () => loadSettings(appOptions).display.language,
  getSystemLocale: () => app.getLocale(),
})

protocol.registerSchemesAsPrivileged([{
  scheme: 'rms-sound',
  privileges: {
    secure: true,
    standard: true,
    stream: true,
    supportFetchAPI: true,
  },
}])

function registerSoundProtocol() {
  protocol.handle('rms-sound', (request) => {
    try {
      const requestUrl = new URL(request.url)
      const parts = requestUrl.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      if (requestUrl.hostname !== 'audio' || parts.length !== 2) {
        return new Response('Sound not found', { status: 404 })
      }
      const filePath = resolveSoundPackFile(
        discoverSoundPacks(appOptions),
        parts[0],
        parts[1],
      )
      if (!filePath) return new Response('Sound not found', { status: 404 })
      return net.fetch(pathToFileURL(filePath).toString())
    } catch {
      return new Response('Sound not found', { status: 404 })
    }
  })
}

const environmentBackend = createEnvironmentService({ ...appOptions, t })
const sessionStore = createSessionStore(environmentBackend.environmentGateway)
const gameFileStore = createGameFileStore(portableRoot)
gameFileStore.ensureDefaultDirectory()
let mainWindow = null
let startupServicesStarted = false
let runtimeMetricsBackendError = ''

const engineIpcController = createEngineIpcController({
  ipcMain,
  appOptions,
  projectRoot,
  environmentGateway: environmentBackend.environmentGateway,
  getMainWindow: () => mainWindow,
  t,
})

const {
  beginRecordTracking,
  markRecordDirty,
  openGame,
  publishRecordDirty,
  restoreStartupRecovery,
  saveGame,
  saveGameAs,
  writeRecoveryGameRecord,
} = createRecordWorkflow({
  app,
  appOptions,
  dialog,
  environmentGateway: environmentBackend.environmentGateway,
  gameFileStore,
  getMainWindow: () => mainWindow,
  t,
})

async function collectRuntimeMetrics() {
  let backendMetrics = null
  try {
    const response = await environmentBackend.environmentGateway.getRuntimeMetrics()
    backendMetrics = response?.metrics || null
    runtimeMetricsBackendError = ''
  } catch (error) {
    // The footer remains available while the backend starts or restarts.
    const message = error instanceof Error ? error.message : String(error)
    if (message !== runtimeMetricsBackendError) {
      console.warn(`[runtime-metrics] backend metrics unavailable: ${message}`)
      runtimeMetricsBackendError = message
    }
  }
  return buildRuntimeMetrics({
    processMetrics: app.getAppMetrics(),
    backendMetrics,
    systemMemory: process.getSystemMemoryInfo(),
  })
}

function saveWindowSettings(window) {
  const latest = loadSettings(appOptions)
  const [width, height] = window.getSize()
  latest.window = {
    ...latest.window,
    width,
    height,
  }
  saveSettings(latest, appOptions)
}

async function downloadMortalReport(rawInput) {
  const sourceUrl = normalizeMortalReportUrl(rawInput, t)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(sourceUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) {
      throw new Error(t('native.download.http', { status: response.status }))
    }
    const text = await readLimitedResponseText(response, 25 * 1024 * 1024, t('native.download.tooLarge'))
    let report
    try {
      report = JSON.parse(text)
    } catch {
      throw new Error(t('native.download.invalidJson'))
    }
    if (!report || !Array.isArray(report.mjai_log) || !report.mjai_log.length) {
      throw new Error(t('native.download.noLog'))
    }
    return { report, sourceUrl }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(t('native.download.timeout'))
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function createMainWindow() {
  const settings = loadSettings(appOptions)

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
    if (input.type !== 'keyDown' || (!input.control && !input.meta) || input.alt) return
    let direction = null
    if (input.code === 'Equal' || input.code === 'NumpadAdd') direction = 'in'
    if (input.code === 'Minus' || input.code === 'NumpadSubtract') direction = 'out'
    if (input.code === 'Digit0' || input.code === 'Numpad0') direction = 'reset'
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

  if (isDev) {
    void window.loadURL(rendererUrl)
  } else {
    void window.loadFile(path.join(projectRoot, 'dist', 'index.html'))
  }

  let closeAllowed = false
  let closeInProgress = false
  window.on('close', (event) => {
    if (closeAllowed) return
    event.preventDefault()
    if (closeInProgress) return
    closeInProgress = true
    void (async () => {
      try {
        saveWindowSettings(window)
      } catch (error) {
        console.warn('[settings] failed to save window state during close:', error)
      }
      try {
        await persistBeforeClose(
          () => requestRendererFlush(window, ipcMain, t('native.closeSaveTimeout')),
          () => loadSettings(appOptions).records?.saveRecoveryOnExit && gameFileStore.isDirty(),
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

function startStartupServices() {
  if (startupServicesStarted) {
    return
  }
  startupServicesStarted = true
  environmentBackend.startAll()
  void engineIpcController.restoreLoadedProfiles()
}

function openMainWindow() {
  mainWindow = createMainWindow()
  startStartupServices()
  return mainWindow
}

function registerIpcHandlers() {
  registerSettingsIpc(ipcMain, appOptions)
  registerApplicationIpc({
    ipcMain,
    appOptions,
    resourceRoot,
    collectRuntimeMetrics,
    t,
  })
  engineIpcController.register()
  registerAnalysisIpc({
    ipcMain,
    environmentGateway: environmentBackend.environmentGateway,
    markRecordDirty,
  })
  ipcMain.handle('record:dirty-get', () => gameFileStore.isDirty())
  registerGameIpc({
    ipcMain,
    environmentGateway: environmentBackend.environmentGateway,
    sessionStore,
    gameFileStore,
    beginRecordTracking,
    markRecordDirty,
    publishRecordDirty,
  })
  ipcMain.handle('backend:restart', async () => {
    const fromCheckpoint = environmentBackend.environmentGateway.needsRecovery()
    if (!fromCheckpoint) await requestRendererFlush(mainWindow, ipcMain, t('native.closeSaveTimeout'))
    let response
    try {
      response = await environmentBackend.environmentGateway.restartBackend()
    } catch (error) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('python:event', { type: 'service_recovery_failed', error: String(error.message || error) })
      }
      throw error
    }
    if (fromCheckpoint && response.state?.gameLoaded) markRecordDirty()
    if (fromCheckpoint && !response.state?.gameLoaded) {
      gameFileStore.closeRecord()
      publishRecordDirty(true)
    }
    gameFileStore.setCurrentNodeId(response.view?.currentNodeId)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python:event', { type: 'service_restored', state: response.state, view: response.view })
    }
    return response
  })
  ipcMain.handle('debug:latest-mjai', () => environmentBackend.environmentGateway.getLatestMjaiDebug())
  ipcMain.handle('game:save', () => saveGame())
  ipcMain.handle('game:save-as', () => saveGameAs())
  ipcMain.handle('game:open', () => openGame())
  ipcMain.handle('record:show-in-folder', () => {
    const recordPath = gameFileStore.getCurrentPath()
    if (!recordPath || !fs.existsSync(recordPath)) return false
    shell.showItemInFolder(recordPath)
    return true
  })
  ipcMain.handle('game:restore-startup-recovery', () => restoreStartupRecovery())
  ipcMain.handle('game:import-mortal-report', async (event, payload) => {
    const request = typeof payload === 'string' ? { input: payload } : (payload || {})
    const originalInput = String(request.input || '').trim()
    const { report, sourceUrl } = await withCurrentRecord(
      gameFileStore, () => downloadMortalReport(originalInput),
    )
    const response = await environmentBackend.environmentGateway.importMortalReport(report, sourceUrl, {
      sourceImportUrl: originalInput,
      reconstructWalls: Boolean(request.reconstructWalls),
      seed: request.seed,
    })
    const sourceName = path.basename(new URL(sourceUrl).pathname, '.json')
    gameFileStore.prepareUnsavedRecord(sourceName)
    beginRecordTracking({
      dirty: true,
      nodeId: response.view?.currentNodeId,
    })
    return {
      sourceUrl,
      reconstruction: response.reconstruction || null,
      state: response.state,
      view: response.view,
      recordDirty: true,
    }
  })
  ipcMain.handle('game:import-custom-tenhou', async (event, payload) => {
    const request = typeof payload === 'string' ? { input: payload } : (payload || {})
    const response = await environmentBackend.environmentGateway.importCustomTenhou(request.input, {
      reconstructWalls: Boolean(request.reconstructWalls),
      seed: request.seed,
    })
    gameFileStore.prepareUnsavedRecord('custom-tenhou')
    beginRecordTracking({
      dirty: true,
      nodeId: response.view?.currentNodeId,
    })
    return {
      reconstruction: response.reconstruction || null,
      state: response.state,
      view: response.view,
      recordDirty: true,
    }
  })
  ipcMain.handle('game:export-custom-tenhou', async () => {
    const response = await environmentBackend.environmentGateway.exportCustomTenhou()
    return response.customTenhou
  })
}

app.whenReady().then(() => {
  registerSoundProtocol()
  environmentBackend.backendProcess.onEvent((event) => {
    if (event.type === 'record_changed') {
      markRecordDirty()
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('python:event', event)
    }
  })
  registerIpcHandlers()
  openMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  environmentBackend.stopAll()
})
