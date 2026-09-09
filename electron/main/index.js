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
const { registerBackendIpc } = require('./ipc/backend-ipc')
const { registerGameIpc } = require('./ipc/game-ipc')
const { registerRecordIpc } = require('./ipc/record-ipc')
const { registerSettingsIpc } = require('./ipc/settings-ipc')
const { registerSoundProtocol } = require('./protocol/sound-protocol')
const { createBackendService } = require('./services/backend-service')
const { createRecordWorkflow } = require('./services/record-workflow')
const { createRuntimeMetricsCollector } = require('./services/runtime-metrics-collector')
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

const backend = createBackendService({ ...appOptions, t })
const sessionStore = createSessionStore(backend.backendGateway)
const gameFileStore = createGameFileStore(portableRoot)
gameFileStore.ensureDefaultDirectory()
let mainWindow = null
let startupServicesStarted = false

const engineIpcController = createEngineIpcController({
  ipcMain,
  appOptions,
  projectRoot,
  backendGateway: backend.backendGateway,
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
  backendGateway: backend.backendGateway,
  gameFileStore,
  getMainWindow: () => mainWindow,
  t,
})

const collectRuntimeMetrics = createRuntimeMetricsCollector({
  app,
  backendGateway: backend.backendGateway,
})

function startStartupServices() {
  if (startupServicesStarted) {
    return
  }
  startupServicesStarted = true
  backend.startAll()
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
    backendGateway: backend.backendGateway,
    markRecordDirty,
  })
  registerGameIpc({
    ipcMain,
    backendGateway: backend.backendGateway,
    sessionStore,
    gameFileStore,
    beginRecordTracking,
    markRecordDirty,
    publishRecordDirty,
  })
  registerBackendIpc({
    ipcMain,
    backendGateway: backend.backendGateway,
    gameFileStore,
    getMainWindow: () => mainWindow,
    markRecordDirty,
    publishRecordDirty,
    t,
  })
  registerRecordIpc({
    ipcMain,
    shell,
    backendGateway: backend.backendGateway,
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
  backend.backendProcess.onEvent((event) => {
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
  backend.stopAll()
})
