const path = require('node:path')
const fs = require('node:fs')
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
const { createEngineIpcController } = require('./ipc/engine-ipc')
const { registerSettingsIpc } = require('./ipc/settings-ipc')
const { createEnvironmentService } = require('./services/environment-service')
const { buildRuntimeMetrics } = require('./runtime-metrics')
const { loadSettings, saveSettings } = require('./state/settings')
const { discoverSoundPacks, resolveSoundPackFile } = require('./state/sound-pack-registry')
const { createSessionStore } = require('./state/session-store')
const { createGameFileStore } = require('./state/game-file-store')
const { normalizeMortalReportUrl } = require('./mortal-report-url')
const { createTranslator } = require('./i18n')
const {
  decodeGameRecord,
  encodeGameRecord,
  getRecoverySourcePath,
  isRecoveryGameRecord,
  prepareGameRecordForWrite,
} = require('./state/game-record-codec')

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
let startupRecoveryAttempted = false
let publishedRecordDirty = false
let closeRequestSerial = 0
let runtimeMetricsBackendError = ''

const engineIpcController = createEngineIpcController({
  ipcMain,
  appOptions,
  projectRoot,
  environmentGateway: environmentBackend.environmentGateway,
  getMainWindow: () => mainWindow,
  t,
})

function publishRecordDirty(force = false) {
  const dirty = gameFileStore.isDirty()
  if (!force && dirty === publishedRecordDirty) return dirty
  publishedRecordDirty = dirty
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('record:dirty-changed', dirty)
  }
  return dirty
}

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

function beginRecordTracking({ dirty, nodeId = null }) {
  gameFileStore.beginRecord({ dirty, nodeId })
  return publishRecordDirty(true)
}

function markRecordDirty() {
  gameFileStore.markDirty()
  return publishRecordDirty()
}

function writeFileAtomically(targetPath, contents) {
  const temporaryPath = `${targetPath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporaryPath, contents)
    fs.renameSync(temporaryPath, targetPath)
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.rmSync(temporaryPath, { force: true })
    }
  }
}

async function writeCurrentGameRecord(targetPath, options = {}) {
  const {
    markSaved = true,
    recovery = false,
    rememberPath = true,
  } = options
  const exportedRevision = gameFileStore.getRevision()
  const response = await environmentBackend.environmentGateway.exportGameRecord()
  const record = prepareGameRecordForWrite(response.record, {
    appVersion: app.getVersion(),
    recovery,
  })
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  const useCompression = path.extname(targetPath).toLowerCase() !== '.json'
  writeFileAtomically(targetPath, encodeGameRecord(record, useCompression))
  if (recovery) {
    gameFileStore.writeRecoverySourcePath(gameFileStore.getCurrentPath())
  }
  if (rememberPath) {
    gameFileStore.setCurrentPath(targetPath)
  }
  if (markSaved) {
    gameFileStore.markSaved(exportedRevision)
  }
  const recordDirty = publishRecordDirty(true)
  return {
    path: targetPath,
    state: response.state,
    view: response.view,
    recordDirty,
    recoveryRecord: gameFileStore.isRecoveryRecord(),
  }
}

function writeRecoveryGameRecord() {
  return writeCurrentGameRecord(gameFileStore.getRecoveryPath(), {
    markSaved: false,
    recovery: true,
    rememberPath: false,
  })
}

async function saveGameAs() {
  const currentPath = gameFileStore.getCurrentPath()
  const suggestedPath = currentPath || gameFileStore.buildDefaultSavePath(fs.existsSync)
  const result = await dialog.showSaveDialog(mainWindow, {
    title: t('native.saveRecord'),
    defaultPath: suggestedPath,
    filters: [
      { name: t('native.recordFilter'), extensions: ['mjtrain'] },
      { name: t('native.legacyRecordFilter'), extensions: ['json'] },
    ],
  })

  if (result.canceled || !result.filePath) {
    return null
  }

  return writeCurrentGameRecord(result.filePath)
}

async function saveGame() {
  const currentPath = gameFileStore.getCurrentPath()
  if (currentPath) {
    return writeCurrentGameRecord(currentPath)
  }
  return saveGameAs()
}

async function importGameRecordFile(filePath) {
  const record = decodeGameRecord(fs.readFileSync(filePath))
  const response = await environmentBackend.environmentGateway.importGameRecord(record)
  const isNativeRecord = path.extname(filePath).toLowerCase() === '.mjtrain'
  const managedRecoveryRecord = gameFileStore.isRecoveryPath(filePath)
  const recoveryRecord = managedRecoveryRecord || isRecoveryGameRecord(record)
  const storedSourcePath = managedRecoveryRecord
    ? gameFileStore.readRecoverySourcePath() || getRecoverySourcePath(record)
    : ''
  const recoverySourcePath = path.isAbsolute(storedSourcePath)
    && !gameFileStore.isRecoveryPath(storedSourcePath)
    ? storedSourcePath
    : ''
  if (recoveryRecord) {
    gameFileStore.openRecoveryRecord(recoverySourcePath, t('record.unsavedName'))
  } else if (isNativeRecord) {
    gameFileStore.setCurrentPath(filePath)
  } else {
    gameFileStore.prepareUnsavedRecord(path.parse(filePath).name)
  }
  const recordDirty = recoveryRecord || !isNativeRecord
  beginRecordTracking({
    dirty: recordDirty,
    nodeId: response.view?.currentNodeId,
  })
  return {
    path: recoveryRecord ? recoverySourcePath : (isNativeRecord ? filePath : ''),
    state: response.state,
    view: response.view,
    recordDirty,
    recoveryRecord,
  }
}

async function openGame() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t('native.openRecord'),
    defaultPath: gameFileStore.getDefaultDirectory(),
    properties: ['openFile'],
    filters: [{ name: t('native.recordFilter'), extensions: ['mjtrain', 'json'] }],
  })

  if (result.canceled || !result.filePaths.length) {
    return null
  }

  return importGameRecordFile(result.filePaths[0])
}

async function restoreStartupRecovery() {
  if (startupRecoveryAttempted) return null
  startupRecoveryAttempted = true

  const settings = loadSettings(appOptions)
  const recoveryPath = gameFileStore.resolveRecoveryPathForRestore()
  if (!settings.records?.saveRecoveryOnExit || !fs.existsSync(recoveryPath)) {
    return null
  }

  try {
    return await importGameRecordFile(recoveryPath)
  } catch (error) {
    console.error('[record] failed to restore exit recovery record:', error)
    if (mainWindow && !mainWindow.isDestroyed()) {
      void dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: t('native.restoreFailed.title'),
        message: t('native.restoreFailed.message'),
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    return null
  }
}

function requestRendererRecordFlush(window, timeoutMs = 5000) {
  if (!window || window.isDestroyed() || window.webContents.isLoading()) {
    return Promise.resolve()
  }
  const token = `${Date.now()}-${++closeRequestSerial}`
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ipcMain.removeListener('record:close-ready', onReady)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const onReady = (event, receivedToken, errorMessage) => {
      if (event.sender !== window.webContents || receivedToken !== token) return
      finish(errorMessage ? new Error(String(errorMessage)) : null)
    }
    const timer = setTimeout(finish, timeoutMs)
    ipcMain.on('record:close-ready', onReady)
    window.webContents.send('record:before-close', token)
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
    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > 25 * 1024 * 1024) {
      throw new Error(t('native.download.tooLarge'))
    }
    const text = await response.text()
    if (text.length > 25 * 1024 * 1024) {
      throw new Error(t('native.download.tooLarge'))
    }
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
        const latest = loadSettings(appOptions)
        if (latest.records?.saveRecoveryOnExit && gameFileStore.isDirty()) {
          await requestRendererRecordFlush(window)
          await writeRecoveryGameRecord()
        }
        closeAllowed = true
        window.close()
      } catch (error) {
        console.error('[record] failed to save exit recovery record:', error)
        const result = await dialog.showMessageBox(window, {
          type: 'error',
          title: t('native.recoverySaveFailed.title'),
          message: t('native.recoverySaveFailed.message'),
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
  ipcMain.handle('record:dirty-get', () => gameFileStore.isDirty())

  ipcMain.handle('status:get', () => sessionStore.getSnapshot())
  ipcMain.handle('game:view', async () => {
    const response = await environmentBackend.environmentGateway.getGameView()
    gameFileStore.setCurrentNodeId(response.view?.currentNodeId)
    return response
  })
  ipcMain.handle('game:create', async () => {
    gameFileStore.prepareUnsavedRecord()
    const response = await sessionStore.createGame()
    beginRecordTracking({ dirty: true })
    return response
  })
  ipcMain.handle('game:close', async () => {
    const response = await environmentBackend.environmentGateway.closeGame()
    gameFileStore.closeRecord()
    publishRecordDirty(true)
    return response
  })
  ipcMain.handle('game:advance', async () => {
    const response = await environmentBackend.environmentGateway.advanceGame()
    gameFileStore.setCurrentNodeId(response.view?.currentNodeId)
    if (response.playPrefetch?.committed !== false) {
      markRecordDirty()
    }
    return response
  })
  ipcMain.handle('game:confirm-review', async () => {
    const response = await environmentBackend.environmentGateway.confirmPendingReview()
    gameFileStore.setCurrentNodeId(response.view?.currentNodeId)
    markRecordDirty()
    return response
  })
  ipcMain.handle('game:submit-action', async (event, action) => {
    const response = await environmentBackend.environmentGateway.submitUserAction(action)
    gameFileStore.setCurrentNodeId(response.view?.currentNodeId)
    markRecordDirty()
    return response
  })
  ipcMain.handle('game:jump-to-node', async (event, nodeId, treeRevision) => {
    const response = await environmentBackend.environmentGateway.jumpToNode(nodeId, treeRevision)
    gameFileStore.markCurrentNode(response.view?.currentNodeId)
    publishRecordDirty()
    return response
  })
  ipcMain.handle('game:set-main-branch', async (event, nodeId) => {
    const response = await environmentBackend.environmentGateway.setMainBranch(nodeId)
    markRecordDirty()
    return response
  })
  ipcMain.handle('game:set-node-comment', async (event, nodeId, comment) => {
    const response = await environmentBackend.environmentGateway.setNodeComment(nodeId, comment)
    if (response.changed) markRecordDirty()
    return response
  })
  ipcMain.handle('game:delete-node', async (event, nodeId) => {
    const response = await environmentBackend.environmentGateway.deleteNode(nodeId)
    gameFileStore.setCurrentNodeId(response.view?.currentNodeId)
    markRecordDirty()
    return response
  })
  ipcMain.handle('backend:restart', async () => {
    return environmentBackend.environmentGateway.restartBackend()
  })
  ipcMain.handle('game:wall-view', () => environmentBackend.environmentGateway.getWallView())
  ipcMain.handle('game:reconstruct-walls', async (event, seed) => {
    const response = await environmentBackend.environmentGateway.reconstructWalls(seed)
    markRecordDirty()
    return response
  })
  ipcMain.handle('game:import-wall', async (event, tiles) => {
    const response = await environmentBackend.environmentGateway.importWall(tiles)
    gameFileStore.setCurrentNodeId(response.view?.currentNodeId)
    markRecordDirty()
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
    const { report, sourceUrl } = await downloadMortalReport(originalInput)
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
  ipcMain.handle('analysis:visibility', (event, visibility) => environmentBackend.environmentGateway.setAnalysisVisibility(visibility))
  ipcMain.handle('game:shanten', () => environmentBackend.environmentGateway.getShanten())
  ipcMain.handle('debug:shanten-mjai', () => environmentBackend.environmentGateway.getShantenMjai())
  ipcMain.handle('debug:clear-analysis-caches', async () => {
    const response = await environmentBackend.environmentGateway.clearAnalysisCaches()
    const cleared = response.cleared || {}
    if (
      Number(cleared.mortalEntries || 0) > 0
      || Number(cleared.opponentEntries || 0) > 0
      || Number(cleared.comparisons || 0) > 0
      || Boolean(cleared.pendingReview)
    ) {
      markRecordDirty()
    }
    return response
  })
  ipcMain.handle('analysis:auto-start', () => environmentBackend.environmentGateway.startAutoAnalysis())
  ipcMain.handle('analysis:auto-cancel', () => environmentBackend.environmentGateway.cancelAutoAnalysis())
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
