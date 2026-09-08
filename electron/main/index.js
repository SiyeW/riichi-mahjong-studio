const path = require('node:path')
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
const { registerEnvironmentIpc } = require('./ipc/environment-ipc')
const { registerGameIpc } = require('./ipc/game-ipc')
const { registerRecordIpc } = require('./ipc/record-ipc')
const { registerSettingsIpc } = require('./ipc/settings-ipc')
const { registerSoundProtocol } = require('./protocol/sound-protocol')
const { createEnvironmentService } = require('./services/environment-service')
const { createRecordWorkflow } = require('./services/record-workflow')
const { buildRuntimeMetrics } = require('./runtime-metrics')
const { loadSettings } = require('./state/settings')
const { createSessionStore } = require('./state/session-store')
const {
  createGameFileStore,
} = require('./state/game-file-store')
const { createTranslator } = require('./i18n')
const { createMainWindow } = require('./window/main-window')

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

function startStartupServices() {
  if (startupServicesStarted) {
    return
  }
  startupServicesStarted = true
  environmentBackend.startAll()
  void engineIpcController.restoreLoadedProfiles()
}

function openMainWindow() {
  mainWindow = createMainWindow({
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
  })
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
  registerGameIpc({
    ipcMain,
    environmentGateway: environmentBackend.environmentGateway,
    sessionStore,
    gameFileStore,
    beginRecordTracking,
    markRecordDirty,
    publishRecordDirty,
  })
  registerEnvironmentIpc({
    ipcMain,
    environmentGateway: environmentBackend.environmentGateway,
    gameFileStore,
    getMainWindow: () => mainWindow,
    markRecordDirty,
    publishRecordDirty,
    t,
  })
  registerRecordIpc({
    ipcMain,
    shell,
    environmentGateway: environmentBackend.environmentGateway,
    gameFileStore,
    beginRecordTracking,
    openGame,
    restoreStartupRecovery,
    saveGame,
    saveGameAs,
    t,
  })
}

app.whenReady().then(() => {
  registerSoundProtocol({ protocol, net, appOptions })
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
