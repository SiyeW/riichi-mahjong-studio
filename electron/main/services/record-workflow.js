const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { withCurrentRecord } = require('../state/record-operation')
const { loadSettings } = require('../state/settings')
const {
  LEGACY_RECORD_FILE_EXTENSION,
  RECORD_FILE_EXTENSION,
  isNativeRecordPath,
  normalizeRecordSavePath,
} = require('../state/game-file-store')
const {
  getRecoverySourcePath,
  isRecoveryGameRecord,
} = require('../state/game-record-codec')

function createRecordWorkflow({
  app,
  appOptions,
  dialog,
  backendGateway,
  gameFileStore,
  getMainWindow,
  t,
}) {
  let startupRecoveryAttempted = false
  let publishedRecordDirty = false

  function publishRecordDirty(force = false) {
    const dirty = gameFileStore.isDirty()
    if (!force && dirty === publishedRecordDirty) return dirty
    publishedRecordDirty = dirty
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('record:dirty-changed', dirty)
    }
    return dirty
  }

  function beginRecordTracking({ dirty, nodeId = null }) {
    gameFileStore.beginRecord({ dirty, nodeId })
    return publishRecordDirty(true)
  }

  function markRecordDirty() {
    gameFileStore.markDirty()
    return publishRecordDirty()
  }

  async function writeCurrentGameRecord(targetPath, options = {}) {
    const {
      markSaved = true,
      recovery = false,
      rememberPath = true,
      onStage = () => {},
    } = options
    const exportedRevision = gameFileStore.getRevision()
    const sourcePath = gameFileStore.getCurrentPath()
    const response = await withCurrentRecord(gameFileStore, async () => {
      const stagingPath = `${targetPath}.${randomUUID()}.tmp`
      try {
        const result = await withCurrentRecord(gameFileStore, async () => {
          onStage('encoding')
          await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
          return backendGateway.exportGameRecordToFile(stagingPath, {
            appVersion: app.getVersion(), recovery,
            compressed: path.extname(targetPath).toLowerCase() !== '.json',
          })
        })
        // The backend has fsynced and closed the complete staging file. Never
        // publish it if the user has replaced the record during preparation.
        onStage('writing')
        await fs.promises.rename(stagingPath, targetPath)
        return result
      } finally {
        await fs.promises.rm(stagingPath, { force: true }).catch(() => {})
      }
    })
    if (recovery) gameFileStore.writeRecoverySourcePath(sourcePath)
    if (rememberPath) gameFileStore.setCurrentPath(targetPath)
    if (markSaved) gameFileStore.markSaved(exportedRevision)
    const recordDirty = publishRecordDirty(true)
    return {
      path: targetPath,
      state: response.state,
      view: response.view,
      recordDirty,
      recoveryRecord: gameFileStore.isRecoveryRecord(),
    }
  }

  function writeRecoveryGameRecord(onStage = () => {}) {
    return writeCurrentGameRecord(gameFileStore.getRecoveryPath(), {
      markSaved: false,
      recovery: true,
      rememberPath: false,
      onStage,
    })
  }

  async function saveGameAs() {
    const currentPath = gameFileStore.getCurrentPath()
    const suggestedPath = currentPath || gameFileStore.buildDefaultSavePath(fs.existsSync)
    const result = await withCurrentRecord(gameFileStore, () => dialog.showSaveDialog(getMainWindow(), {
      title: t('native.saveRecord'),
      defaultPath: suggestedPath,
      filters: [{ name: t('native.recordFilter'), extensions: [RECORD_FILE_EXTENSION.slice(1)] }],
    }))
    if (result.canceled || !result.filePath) return null
    return writeCurrentGameRecord(normalizeRecordSavePath(result.filePath))
  }

  async function saveGame() {
    const currentPath = gameFileStore.getCurrentPath()
    return currentPath ? writeCurrentGameRecord(currentPath) : saveGameAs()
  }

  async function importGameRecordFile(filePath) {
    const response = await backendGateway.importGameRecordFile(filePath)
    const record = { metadata: response.recordMetadata }
    const isNativeRecord = isNativeRecordPath(filePath)
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
      const nativeRecoverySourcePath = isNativeRecordPath(recoverySourcePath) ? recoverySourcePath : ''
      const recoveryDisplayName = recoverySourcePath ? path.parse(recoverySourcePath).name : t('record.unsavedName')
      gameFileStore.openRecoveryRecord(nativeRecoverySourcePath, recoveryDisplayName)
    } else if (isNativeRecord) {
      gameFileStore.setCurrentPath(filePath)
    } else {
      gameFileStore.prepareUnsavedRecord(path.parse(filePath).name)
    }
    const recordDirty = recoveryRecord || !isNativeRecord
    beginRecordTracking({ dirty: recordDirty, nodeId: response.view?.currentNodeId })
    return {
      path: recoveryRecord ? gameFileStore.getCurrentPath() || '' : (isNativeRecord ? filePath : ''),
      state: response.state,
      view: response.view,
      recordDirty,
      recoveryRecord,
    }
  }

  async function openGame() {
    const result = await withCurrentRecord(gameFileStore, () => dialog.showOpenDialog(getMainWindow(), {
      title: t('native.openRecord'),
      defaultPath: gameFileStore.getDefaultDirectory(),
      properties: ['openFile'],
      filters: [{
        name: t('native.recordFilter'),
        extensions: [RECORD_FILE_EXTENSION, LEGACY_RECORD_FILE_EXTENSION, '.json']
          .map((extension) => extension.slice(1)),
      }],
    }))
    if (result.canceled || !result.filePaths.length) return null
    return importGameRecordFile(result.filePaths[0])
  }

  async function restoreStartupRecovery() {
    if (startupRecoveryAttempted) return null
    startupRecoveryAttempted = true
    const settings = loadSettings(appOptions)
    const recoveryPath = gameFileStore.resolveRecoveryPathForRestore()
    if (!settings.records?.saveRecoveryOnExit || !fs.existsSync(recoveryPath)) return null
    try {
      return await importGameRecordFile(recoveryPath)
    } catch (error) {
      console.error('[record] failed to restore exit recovery record:', error)
      const mainWindow = getMainWindow()
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

  return {
    beginRecordTracking,
    markRecordDirty,
    openGame,
    publishRecordDirty,
    restoreStartupRecovery,
    saveGame,
    saveGameAs,
    writeRecoveryGameRecord,
  }
}

module.exports = { createRecordWorkflow }
