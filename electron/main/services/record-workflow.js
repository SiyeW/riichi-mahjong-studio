const fs = require('node:fs')
const path = require('node:path')
const { acquireRecordLease } = require('./record-live-lease')
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
    if (backendGateway.getRecordRuntime) gameFileStore.observeRuntime(backendGateway.getRecordRuntime())
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
      rememberPath = true,
      onStage = () => {},
    } = options
    targetPath = path.resolve(targetPath)
    const targetIdentity = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath
    const lease = await acquireRecordLease('save-target', targetIdentity)
    const recordGeneration = gameFileStore.getRecordGeneration()
    let token, stagingPath, promoted = false
    try {
      const previous = await fs.promises.stat(targetPath).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      onStage('encoding')
      await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
      token = await backendGateway.captureRecordSave(targetPath, app.getVersion())
      stagingPath = `${targetPath}.${token.saveId}.tmp`
      await backendGateway.writeRecordSave(token, stagingPath)
      const current = await fs.promises.stat(targetPath).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (Boolean(previous) !== Boolean(current) || previous &&
          (previous.size !== current.size || previous.mtimeMs !== current.mtimeMs || previous.ino !== current.ino)) {
        throw new Error('The save target changed while the record was being written.')
      }
      lease.assertOwned()
      onStage('writing')
      await fs.promises.rename(stagingPath, targetPath)
      promoted = true
      await backendGateway.acknowledgeRecordSave(token)
      if (recordGeneration === gameFileStore.getRecordGeneration() && rememberPath) gameFileStore.setCurrentPath(targetPath)
    } catch (error) {
      if (token && !promoted) await backendGateway.abortRecordSave(token).catch(() => {})
      throw error
    } finally {
      if (stagingPath) await fs.promises.rm(stagingPath, { force: true }).catch(() => {})
      await lease.release()
    }
    const recordDirty = publishRecordDirty(true)
    return {
      path: targetPath,
      recordDirty,
      recoveryRecord: gameFileStore.isRecoveryRecord(),
    }
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
    const response = await backendGateway.importGameRecordFile(filePath,
      { clean: isNativeRecordPath(filePath) && !gameFileStore.isRecoveryPath(filePath),
        target: gameFileStore.isRecoveryPath(filePath) ? '' : filePath })
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
    if (!settings.records?.saveRecoveryOnExit) return null
    try {
      const response = await backendGateway.restoreRecordRecovery()
      if (response) {
        const runtime = backendGateway.getRecordRuntime()
        gameFileStore.openRecoveryRecord(runtime?.savedPath || '', t('record.unsavedName'))
        beginRecordTracking({ dirty: runtime?.contentRevision !== runtime?.savedContentRevision,
          nodeId: response.view?.currentNodeId })
        return { ...response, path: runtime?.savedPath || '', recordDirty: gameFileStore.isDirty(), recoveryRecord: true }
      }
      // Narrow one-time reader for existing released recovery files; new exits
      // never create another portable recovery snapshot.
      const recoveryPath = gameFileStore.resolveRecoveryPathForRestore()
      if (fs.existsSync(recoveryPath)) return await importGameRecordFile(recoveryPath)
      return null
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
  }
}

module.exports = { createRecordWorkflow }
