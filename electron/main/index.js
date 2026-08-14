const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')

const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
} = require('electron')
const { createEnvironmentService } = require('./services/environment-service')
const { buildRuntimeMetrics } = require('./runtime-metrics')
const { buildSettings, loadSettings, saveSettings } = require('./state/settings')
const { discoverEnginePackages } = require('./state/engine-package-registry')
const { discoverSoundPacks, resolveSoundPackFile } = require('./state/sound-pack-registry')
const { createSessionStore } = require('./state/session-store')
const { createGameFileStore } = require('./state/game-file-store')
const { normalizeMortalReportUrl } = require('./mortal-report-url')
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
  appDir: projectRoot,
  resourceDir: resourceRoot,
  portableDir: portableRoot,
  env: process.env,
  cwd: process.cwd(),
  isPackaged: app.isPackaged,
  execPath: process.execPath,
}

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

const APP_LEGAL_DOCUMENTS = Object.freeze({
  license: 'LICENSE',
  thirdPartyNotices: 'THIRD_PARTY_NOTICES.md',
})

async function openLocalDocument(filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error('声明文件不存在，请检查安装是否完整')
  }
  const errorMessage = await shell.openPath(filePath)
  if (errorMessage) throw new Error(errorMessage)
  return true
}

const environmentBackend = createEnvironmentService(appOptions)
const sessionStore = createSessionStore(environmentBackend.environmentGateway)
const gameFileStore = createGameFileStore(portableRoot)
gameFileStore.ensureDefaultDirectory()
let mainWindow = null
let startupServicesStarted = false
let startupRecoveryAttempted = false
let publishedRecordDirty = false
let closeRequestSerial = 0
let runtimeMetricsBackendError = ''

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

function saveLoadedEngineProfileState(profileId, loaded) {
  const settings = loadSettings(appOptions)
  const loadedProfileIds = new Set(settings.engines.loadedProfileIds || [])
  if (loaded) loadedProfileIds.add(profileId)
  else loadedProfileIds.delete(profileId)
  settings.engines.loadedProfileIds = [...loadedProfileIds]
  saveSettings(settings, appOptions)
  return settings
}

async function restoreLoadedEngineProfiles() {
  const settings = loadSettings(appOptions)
  for (const profileId of settings.engines.loadedProfileIds || []) {
    try {
      await environmentBackend.environmentGateway.reloadEngine(profileId)
    } catch (error) {
      console.error(`[engine] failed to restore ${profileId}:`, error)
    }
  }
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
    title: 'Save Game Record',
    defaultPath: suggestedPath,
    filters: [
      { name: 'Mjai Studio Record', extensions: ['mjtrain'] },
      { name: 'Legacy JSON Record', extensions: ['json'] },
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
    gameFileStore.openRecoveryRecord(recoverySourcePath)
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
    title: 'Open Game Record',
    defaultPath: gameFileStore.getDefaultDirectory(),
    properties: ['openFile'],
    filters: [{ name: 'Mjai Studio Record', extensions: ['mjtrain', 'json'] }],
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
        title: '恢复上次内容失败',
        message: '未能自动读取退出时保留的内容，程序将继续正常启动。',
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
  const sourceUrl = normalizeMortalReportUrl(rawInput)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(sourceUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) {
      throw new Error(`下载失败（HTTP ${response.status}）。`)
    }
    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > 25 * 1024 * 1024) {
      throw new Error('报告文件过大，已停止导入。')
    }
    const text = await response.text()
    if (text.length > 25 * 1024 * 1024) {
      throw new Error('报告文件过大，已停止导入。')
    }
    let report
    try {
      report = JSON.parse(text)
    } catch {
      throw new Error('下载内容不是有效的 JSON 报告。')
    }
    if (!report || !Array.isArray(report.mjai_log) || !report.mjai_log.length) {
      throw new Error('报告中没有可读取的 mjai_log。')
    }
    return { report, sourceUrl }
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('下载超时，请检查网络后重试。')
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
          title: '恢复存档保存失败',
          message: '未能在退出前保存未保存内容。',
          detail: error instanceof Error ? error.message : String(error),
          buttons: ['取消退出', '仍然退出'],
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
  void restoreLoadedEngineProfiles()
}

function openMainWindow() {
  mainWindow = createMainWindow()
  startStartupServices()
  return mainWindow
}

function registerIpcHandlers() {
  ipcMain.handle('settings:get', () => buildSettings(loadSettings(appOptions), appOptions))
  ipcMain.handle('record:dirty-get', () => gameFileStore.isDirty())

  ipcMain.handle('settings:save', (event, patch) => {
    const current = loadSettings(appOptions)
    const next = {
      ...current,
      ...patch,
      modeDefaults: {
        ...current.modeDefaults,
        ...(patch?.modeDefaults || {}),
      },
      display: {
        ...current.display,
        ...(patch?.display || {}),
      },
      records: {
        ...current.records,
        ...(patch?.records || {}),
      },
      audio: {
        ...current.audio,
        ...(patch?.audio || {}),
      },
      window: {
        ...current.window,
        ...(patch?.window || {}),
      },
    }
    saveSettings(next, appOptions)
    return buildSettings(next, appOptions)
  })

  ipcMain.handle('engine:describe', async (event, profile) => {
    const enginePath = String(profile?.enginePath || '')
    const request = {
      ...(profile || {}),
      engineCommand: Array.isArray(profile?.engineCommand) && profile.engineCommand.length
        ? profile.engineCommand.map(String)
        : (enginePath ? [enginePath] : []),
      engineCwd: String(profile?.engineCwd || '') || (enginePath ? path.dirname(enginePath) : ''),
    }
    const response = await environmentBackend.environmentGateway.describeEngine(request)
    return response.description
  })

  ipcMain.handle('engine:choose-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择引擎文件',
      properties: ['openFile'],
      filters: [
        { name: '引擎', extensions: ['exe', 'py'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    return result.canceled ? '' : String(result.filePaths[0] || '')
  })

  ipcMain.handle('engine:choose-weight', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择权重文件',
      properties: ['openFile'],
      filters: [
        { name: '模型权重', extensions: ['pth', 'pt', 'onnx', 'bin'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    return result.canceled ? '' : String(result.filePaths[0] || '')
  })

  ipcMain.handle('engine:activate', async (event, payload) => {
    const profileId = String(payload?.profileId || '')
    if (!profileId) throw new Error('没有选择要加载的引擎')
    const previous = loadSettings(appOptions)
    const engines = JSON.parse(JSON.stringify(payload?.engines || previous.engines))
    const profiles = engines.profiles
    const profile = Array.isArray(profiles)
      ? profiles.find((item) => item?.id === profileId)
      : null
    if (!profile) throw new Error('找不到要加载的引擎配置')
    const enginePath = path.isAbsolute(profile.enginePath || '')
      ? profile.enginePath
      : path.resolve(projectRoot, profile.enginePath || '')
    if (!enginePath || !fs.existsSync(enginePath)) {
      throw new Error('引擎文件不存在')
    }
    for (const weight of profile.weights || []) {
      const weightPath = path.isAbsolute(weight.path || '')
        ? weight.path
        : path.resolve(projectRoot, weight.path || '')
      if (!weightPath || !fs.existsSync(weightPath)) {
        throw new Error(`权重文件不存在：${weight.slotId || '未命名槽位'}`)
      }
    }
    const assignedOutputs = Object.entries(engines.outputAssignments || {})
      .filter(([, assignedProfileId]) => assignedProfileId === profileId)
      .map(([outputId]) => outputId)
    if (!assignedOutputs.length) throw new Error('尚未给这个引擎分配输出')
    const attempted = { ...previous, engines }
    saveSettings(attempted, appOptions)
    const response = await environmentBackend.environmentGateway.reloadEngine(profileId)
    if (assignedOutputs.includes('action-recommendation')) {
      if (response?.reload?.errors?.decision) {
        throw new Error(String(response.reload.errors.decision))
      }
      if (!response?.reload?.warmed?.teachingAnalysis) {
        throw new Error('动作推荐未能完成加载')
      }
    }
    if (assignedOutputs.some((outputId) => outputId !== 'action-recommendation')) {
      if (response?.reload?.errors?.['opponent-analysis']) {
        throw new Error(String(response.reload.errors['opponent-analysis']))
      }
      if (!response?.reload?.warmed?.opponentAnalysis) {
        throw new Error('对手预测未能完成加载')
      }
    }
    return buildSettings(saveLoadedEngineProfileState(profileId, true), appOptions)
  })

  ipcMain.handle('engine:unload', async (event, payload) => {
    const profileId = String(payload?.profileId || '')
    const engines = loadSettings(appOptions).engines
    const assignedOutputs = Object.entries(engines.outputAssignments || {})
      .filter(([, assignedProfileId]) => assignedProfileId === profileId)
      .map(([outputId]) => outputId)
    let state = null
    if (assignedOutputs.includes('action-recommendation')) {
      state = (await environmentBackend.environmentGateway.unloadEngine('decision', profileId)).state
    }
    if (
      assignedOutputs.includes('opponent-shanten')
      || assignedOutputs.includes('opponent-deal-in-probability')
    ) {
      state = (await environmentBackend.environmentGateway.unloadEngine('opponent-analysis', profileId)).state
    }
    const settings = saveLoadedEngineProfileState(profileId, false)
    return {
      state,
      settings: buildSettings(settings, appOptions),
    }
  })

  ipcMain.handle('status:get', () => sessionStore.getSnapshot())
  ipcMain.handle('system:runtime-metrics', () => collectRuntimeMetrics())
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
  ipcMain.handle('clipboard:read-text', () => clipboard.readText())
  ipcMain.handle('clipboard:write-text', (event, text) => {
    clipboard.writeText(String(text || ''))
    return { ok: true }
  })
  ipcMain.handle('system:open-external', async (event, value) => {
    const target = new URL(String(value || ''))
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new Error('仅允许打开网页链接')
    }
    await shell.openExternal(target.toString())
    return true
  })
  ipcMain.handle('legal:open-app-document', async (event, documentId) => {
    const fileName = APP_LEGAL_DOCUMENTS[String(documentId || '')]
    if (!fileName) throw new Error('未知的声明文件')
    return openLocalDocument(path.join(resourceRoot, fileName))
  })
  ipcMain.handle('legal:open-engine-document', async (event, payload) => {
    const field = payload?.kind === 'license'
      ? 'licenses'
      : payload?.kind === 'notice'
        ? 'notices'
        : ''
    if (!field) throw new Error('未知的引擎声明类型')
    const engineId = String(payload?.engineId || '')
    const documentIndex = Number(payload?.index)
    const engine = discoverEnginePackages(appOptions).engines.find((item) => item.id === engineId)
    const document = Number.isInteger(documentIndex) ? engine?.[field]?.[documentIndex] : null
    if (!document?.available) throw new Error('引擎声明文件不存在')
    return openLocalDocument(document.resolvedPath)
  })
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
