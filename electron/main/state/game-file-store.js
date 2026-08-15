const path = require('node:path')
const fs = require('node:fs')

function padNumber(value, length = 2) {
  return String(value).padStart(length, '0')
}

function buildTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    padNumber(date.getMonth() + 1),
    padNumber(date.getDate()),
    '-',
    padNumber(date.getHours()),
    padNumber(date.getMinutes()),
    padNumber(date.getSeconds()),
  ].join('')
}

function sanitizeSourceName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\.[^.]+$/, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '')
    .slice(0, 40)
    .replace(/[.\-\s]+$/g, '')
}

function buildSuggestedFileName(sourceName = '', date = new Date()) {
  const cleanSourceName = sanitizeSourceName(sourceName)
  const suffix = cleanSourceName ? `-${cleanSourceName}` : ''
  return `${buildTimestamp(date)}${suffix}.mjtrain`
}

const RECOVERY_DIRECTORY_NAME = '.recovery'
const RECOVERY_DISPLAY_NAME = '未保存的对局'
const RECOVERY_FILE_NAME = `${RECOVERY_DISPLAY_NAME}.mjtrain`
const LEGACY_RECOVERY_FILE_NAME = '未保存的恢复存档.mjtrain'
const RECOVERY_SESSION_FILE_NAME = 'session.json'

function pathsEqual(left, right) {
  if (!left || !right) return false
  const normalize = (value) => path.resolve(value).replaceAll('\\', '/').toLowerCase()
  return normalize(left) === normalize(right)
}

function createGameFileStore(baseDir) {
  let currentPath = null
  let suggestedFileName = null
  let lastSuggestedBaseName = null
  let repeatedSuggestionCount = 0
  let recordActive = false
  let revision = 0
  let savedRevision = 0
  let currentNodeId = null
  let recoveryRecord = false

  function isDirty() {
    return recordActive && revision !== savedRevision
  }

  function markDirty() {
    if (!recordActive) return false
    revision += 1
    return isDirty()
  }

  function recoveryPath() {
    return path.join(baseDir, 'records', RECOVERY_DIRECTORY_NAME, RECOVERY_FILE_NAME)
  }

  function legacyRecoveryPath() {
    return path.join(baseDir, 'records', LEGACY_RECOVERY_FILE_NAME)
  }

  function recoverySessionPath() {
    return path.join(baseDir, 'records', RECOVERY_DIRECTORY_NAME, RECOVERY_SESSION_FILE_NAME)
  }

  return {
    getCurrentPath() {
      return currentPath
    },
    setCurrentPath(nextPath) {
      currentPath = nextPath || null
      recoveryRecord = false
      if (currentPath) {
        suggestedFileName = path.basename(currentPath)
      }
      return currentPath
    },
    clearCurrentPath() {
      currentPath = null
    },
    openRecoveryRecord(sourcePath = '', displayName = RECOVERY_DISPLAY_NAME) {
      currentPath = sourcePath || null
      recoveryRecord = true
      suggestedFileName = currentPath
        ? path.basename(currentPath)
        : buildSuggestedFileName(displayName)
      return suggestedFileName
    },
    isRecoveryRecord() {
      return recoveryRecord
    },
    getRecoveryPath() {
      return recoveryPath()
    },
    getRecoverySessionPath() {
      return recoverySessionPath()
    },
    writeRecoverySourcePath(sourcePath = '') {
      const sessionPath = recoverySessionPath()
      const normalized = typeof sourcePath === 'string'
        && path.isAbsolute(sourcePath)
        && !pathsEqual(sourcePath, recoveryPath())
        ? path.resolve(sourcePath)
        : ''
      if (!normalized) {
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { force: true })
        return ''
      }
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
      fs.writeFileSync(sessionPath, `${JSON.stringify({ sourcePath: normalized })}\n`, 'utf8')
      return normalized
    },
    readRecoverySourcePath() {
      const sessionPath = recoverySessionPath()
      if (!fs.existsSync(sessionPath)) return ''
      try {
        const sourcePath = JSON.parse(fs.readFileSync(sessionPath, 'utf8'))?.sourcePath
        if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) return ''
        if (pathsEqual(sourcePath, recoveryPath()) || pathsEqual(sourcePath, legacyRecoveryPath())) return ''
        return path.resolve(sourcePath)
      } catch {
        return ''
      }
    },
    resolveRecoveryPathForRestore() {
      const targetPath = recoveryPath()
      if (fs.existsSync(targetPath)) return targetPath

      const legacyPath = legacyRecoveryPath()
      if (!fs.existsSync(legacyPath)) return targetPath
      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true })
        fs.renameSync(legacyPath, targetPath)
        return targetPath
      } catch {
        // A locked legacy file can still be restored and will be replaced at
        // the new location on the next exit save.
        return legacyPath
      }
    },
    isRecoveryPath(filePath) {
      return pathsEqual(filePath, recoveryPath()) || pathsEqual(filePath, legacyRecoveryPath())
    },
    prepareUnsavedRecord(sourceName = '', date = new Date()) {
      currentPath = null
      recoveryRecord = false
      const baseName = buildSuggestedFileName(sourceName, date)
      if (baseName === lastSuggestedBaseName) {
        repeatedSuggestionCount += 1
        const parsed = path.parse(baseName)
        suggestedFileName = `${parsed.name}-${repeatedSuggestionCount}${parsed.ext}`
      } else {
        lastSuggestedBaseName = baseName
        repeatedSuggestionCount = 1
        suggestedFileName = baseName
      }
      return suggestedFileName
    },
    beginRecord({ dirty = false, nodeId = null } = {}) {
      recordActive = true
      revision += 1
      savedRevision = dirty ? revision - 1 : revision
      currentNodeId = nodeId || null
      return dirty
    },
    closeRecord() {
      currentPath = null
      suggestedFileName = null
      recordActive = false
      currentNodeId = null
      recoveryRecord = false
      savedRevision = revision
      return false
    },
    markDirty() {
      return markDirty()
    },
    markSaved(exportedRevision) {
      if (!recordActive) return false
      savedRevision = Number(exportedRevision)
      return revision !== savedRevision
    },
    getRevision() {
      return revision
    },
    isDirty() {
      return isDirty()
    },
    setCurrentNodeId(nodeId) {
      currentNodeId = nodeId || null
    },
    markCurrentNode(nodeId) {
      const nextNodeId = nodeId || null
      if (!recordActive || nextNodeId === currentNodeId) return isDirty()
      currentNodeId = nextNodeId
      return markDirty()
    },
    getDefaultDirectory() {
      return path.join(baseDir, 'records')
    },
    ensureDefaultDirectory() {
      const directory = path.join(baseDir, 'records')
      fs.mkdirSync(directory, { recursive: true })
      return directory
    },
    buildDefaultSavePath(pathExists = () => false) {
      const directory = path.join(baseDir, 'records')
      const fileName = suggestedFileName || buildSuggestedFileName()
      const parsed = path.parse(fileName)
      let candidate = path.join(directory, fileName)
      let suffix = 2
      while (pathExists(candidate)) {
        candidate = path.join(directory, `${parsed.name}-${suffix}${parsed.ext}`)
        suffix += 1
      }
      return candidate
    },
  }
}

module.exports = {
  LEGACY_RECOVERY_FILE_NAME,
  RECOVERY_DIRECTORY_NAME,
  RECOVERY_DISPLAY_NAME,
  RECOVERY_FILE_NAME,
  RECOVERY_SESSION_FILE_NAME,
  buildSuggestedFileName,
  createGameFileStore,
  pathsEqual,
  sanitizeSourceName,
}
