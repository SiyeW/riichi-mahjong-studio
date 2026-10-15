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
  let savedPathGeneration = -1
  let rememberedPathIntent = 0

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
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
    const canonical = await fs.promises.realpath(targetPath).catch(async error => {
      if (error.code !== 'ENOENT') throw error
      return path.join(await fs.promises.realpath(path.dirname(targetPath)), path.basename(targetPath))
    })
    const targetIdentity = process.platform === 'win32' ? canonical.toLowerCase() : canonical
    const lease = await acquireRecordLease('save-target', targetIdentity).catch(error => {
      if (error.code === 'EADDRINUSE') throw new Error(t('native.saveTargetBusy'))
      throw error
    })
    const recordGeneration = gameFileStore.getRecordGeneration()
    let token, stagingPath, promoted = false, recoveryWarning = ''
    try {
      const previous = await fs.promises.stat(targetPath).catch(error => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      onStage('encoding')
      token = await backendGateway.captureRecordSave(targetPath, app.getVersion())
      stagingPath = `${targetPath}.${token.saveId}.tmp`
      const written = await backendGateway.writeRecordSave(token, stagingPath)
      recoveryWarning = written?.result?.recoveryError || ''
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
    } catch (error) {
      if (!promoted) {
        if (token) await backendGateway.abortRecordSave(token).catch(() => {})
        throw error
      }
      // Promotion is the file commit. A failed local ACK cannot turn a valid
      // rescue artifact into a failed Save; keep dirty/recovery state honest.
      recoveryWarning = error instanceof Error ? error.message : String(error)
      await backendGateway.releaseRecordSave(token).catch(() => {})
      console.warn('[record] file saved but recovery acknowledgement failed:', recoveryWarning)
    } finally {
      if (stagingPath) await fs.promises.rm(stagingPath, { force: true }).catch(() => {})
      await lease.release()
    }
    if (recordGeneration === gameFileStore.getRecordGeneration() && rememberPath) {
      if (savedPathGeneration !== recordGeneration) {
        savedPathGeneration = recordGeneration
        rememberedPathIntent = 0
      }
      if (token.pathIntent >= rememberedPathIntent) {
        rememberedPathIntent = token.pathIntent
        gameFileStore.setCurrentPath(targetPath)
      }
    }
    const recordDirty = publishRecordDirty(true)
    return {
      path: targetPath,
      recordDirty,
      recoveryRecord: gameFileStore.isRecoveryRecord(),
      ...(recoveryWarning ? { recoveryWarning } : {}),
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
      }, { name: t('native.allFiles'), extensions: ['*'] }],
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
        completeLegacyRecoveryMigration()
        const runtime = backendGateway.getRecordRuntime()
        gameFileStore.openRecoveryRecord(runtime?.savedPath || '', t('record.unsavedName'))
        beginRecordTracking({ dirty: runtime?.contentRevision !== runtime?.savedContentRevision,
          nodeId: response.view?.currentNodeId })
        const warning = response.recoveryError || response.saveReconciliationErrors?.map(item => item.stagingPath
          ? t('native.unfinishedSaveFile', { path: item.stagingPath }) : item.error).join('\n')
        const mainWindow = getMainWindow()
        if ((warning || response.recoveryUnclean) && mainWindow && !mainWindow.isDestroyed()) {
          void dialog.showMessageBox(mainWindow, { type: 'warning', title: t('native.recoveryIncomplete.title'),
            message: t('native.recoveryIncomplete.message'), detail: warning || '' })
        }
        return { ...response, path: runtime?.savedPath || '', recordDirty: gameFileStore.isDirty(), recoveryRecord: true }
      }
      // Narrow one-time reader for existing released recovery files; new exits
      // never create another portable recovery snapshot.
      const directory = path.resolve(gameFileStore.getDefaultDirectory())
      const lease = await acquireRecordLease('legacy-recovery', process.platform === 'win32'
        ? directory.toLowerCase() : directory).catch(error => {
        if (error.code === 'EADDRINUSE') return null
        throw error
      })
      if (!lease) return null
      try {
        const recoveryPath = gameFileStore.resolveRecoveryPathForRestore()
        if (!recoveryPath || !fs.existsSync(recoveryPath)) return null
        const restored = await importGameRecordFile(recoveryPath)
        completeLegacyRecoveryMigration()
        return restored
      } finally { await lease.release() }
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

  function completeLegacyRecoveryMigration() {
    try {
      gameFileStore.completeLegacyRecoveryMigration()
    } catch (error) {
      // The record is already active. A bookkeeping failure must not hide its
      // successful restoration or make the renderer keep showing an empty table.
      console.error('[record] failed to retire legacy recovery fallback:', error)
      const mainWindow = getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        void dialog.showMessageBox(mainWindow, { type: 'warning', title: t('native.recoveryIncomplete.title'),
          message: t('native.recoveryIncomplete.message'), detail: String(error.message || error) })
      }
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
