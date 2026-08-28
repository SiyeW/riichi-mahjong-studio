const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  LEGACY_RECOVERY_FILE_NAME,
  PREVIOUS_RECOVERY_FILE_NAME,
  RECOVERY_DIRECTORY_NAME,
  RECOVERY_FILE_NAME,
  RECOVERY_SESSION_FILE_NAME,
  createGameFileStore,
  isNativeRecordPath,
  normalizeRecordSavePath,
  pathsEqual,
} = require('./game-file-store')

function testRecordFileExtensions() {
  assert.equal(isNativeRecordPath('D:\\records\\game.mjstudio'), true)
  assert.equal(isNativeRecordPath('D:\\records\\game.MJSTUDIO'), true)
  assert.equal(isNativeRecordPath('D:\\records\\game.mjtrain'), false)
  assert.equal(normalizeRecordSavePath('D:\\records\\game.mjstudio'), 'D:\\records\\game.mjstudio')
  assert.equal(normalizeRecordSavePath('D:\\records\\game.MJSTUDIO'), 'D:\\records\\game.mjstudio')
  assert.equal(normalizeRecordSavePath('D:\\records\\game.mjtrain'), 'D:\\records\\game.mjstudio')
  assert.equal(normalizeRecordSavePath('D:\\records\\game'), 'D:\\records\\game.mjstudio')
}

function testRecoveryRecordLifecycle() {
  const baseDir = path.resolve('D:/portable-test')
  const store = createGameFileStore(baseDir)

  assert.equal(store.getRecoveryPath(), path.join(baseDir, 'records', RECOVERY_DIRECTORY_NAME, RECOVERY_FILE_NAME))
  assert.equal(store.isRecoveryPath(store.getRecoveryPath()), true)
  assert.equal(store.isRecoveryPath(path.join(
    baseDir,
    'records',
    RECOVERY_DIRECTORY_NAME,
    PREVIOUS_RECOVERY_FILE_NAME,
  )), true)
  assert.equal(store.isRecoveryPath(path.join(baseDir, 'records', LEGACY_RECOVERY_FILE_NAME)), true)
  assert.equal(pathsEqual('D:/Portable-Test/records/a', 'd:\\portable-test\\records\\a'), true)

  const sourcePath = path.join(baseDir, 'records', 'original.mjtrain')
  store.openRecoveryRecord(sourcePath)
  store.beginRecord({ dirty: false })
  assert.equal(store.isRecoveryRecord(), true)
  assert.equal(store.getCurrentPath(), sourcePath)
  assert.equal(store.isDirty(), false)

  store.markDirty()
  assert.equal(store.isDirty(), true)
  store.setCurrentPath(path.join(baseDir, 'records', 'formal.mjstudio'))
  assert.equal(store.isRecoveryRecord(), false)

  assert.match(store.openRecoveryRecord(), /未保存的对局\.mjstudio$/)
  assert.equal(store.getCurrentPath(), null)

  store.beginRecord({ dirty: true, nodeId: 'node-1' })
  store.closeRecord()
  assert.equal(store.getCurrentPath(), null)
  assert.equal(store.isRecoveryRecord(), false)
  assert.equal(store.isDirty(), false)
  store.markDirty()
  assert.equal(store.isDirty(), false)
}

function testRecoverySourcePathUsesLocalSessionMetadata() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjai-recovery-session-'))
  try {
    const store = createGameFileStore(baseDir)
    const sourcePath = path.join(baseDir, 'records', 'original.mjtrain')
    assert.equal(store.getRecoverySessionPath(), path.join(
      baseDir,
      'records',
      RECOVERY_DIRECTORY_NAME,
      RECOVERY_SESSION_FILE_NAME,
    ))
    assert.equal(store.writeRecoverySourcePath(sourcePath), sourcePath)
    assert.equal(store.readRecoverySourcePath(), sourcePath)
    assert.equal(store.writeRecoverySourcePath('relative.mjtrain'), '')
    assert.equal(store.readRecoverySourcePath(), '')
    assert.equal(store.writeRecoverySourcePath(sourcePath), sourcePath)
    assert.equal(store.writeRecoverySourcePath(null), '')
    assert.equal(store.readRecoverySourcePath(), '')
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true })
  }
}

function testPreviousRecoveryRecordUsesTheNewExtension() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjai-previous-recovery-'))
  const previousPath = path.join(baseDir, 'records', RECOVERY_DIRECTORY_NAME, PREVIOUS_RECOVERY_FILE_NAME)
  try {
    fs.mkdirSync(path.dirname(previousPath), { recursive: true })
    fs.writeFileSync(previousPath, 'previous recovery')
    const store = createGameFileStore(baseDir)

    assert.equal(store.resolveRecoveryPathForRestore(), store.getRecoveryPath())
    assert.equal(fs.existsSync(previousPath), false)
    assert.equal(fs.readFileSync(store.getRecoveryPath(), 'utf8'), 'previous recovery')
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true })
  }
}

function testLegacyRecoveryRecordIsMovedOutOfTheRecordsRoot() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjai-recovery-'))
  const legacyPath = path.join(baseDir, 'records', LEGACY_RECOVERY_FILE_NAME)
  try {
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, 'legacy recovery')
    const store = createGameFileStore(baseDir)

    assert.equal(store.resolveRecoveryPathForRestore(), store.getRecoveryPath())
    assert.equal(fs.existsSync(legacyPath), false)
    assert.equal(fs.readFileSync(store.getRecoveryPath(), 'utf8'), 'legacy recovery')
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true })
  }
}

function testDefaultDirectoryIsCreatedBesideExecutableRoot() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjai-records-'))
  const recordsDirectory = path.join(baseDir, 'records')
  try {
    const store = createGameFileStore(baseDir)
    assert.equal(fs.existsSync(recordsDirectory), false)
    assert.equal(store.ensureDefaultDirectory(), recordsDirectory)
    assert.equal(fs.statSync(recordsDirectory).isDirectory(), true)
    assert.equal(store.getDefaultDirectory(), recordsDirectory)
    assert.equal(store.buildDefaultSavePath().startsWith(`${recordsDirectory}${path.sep}`), true)
    assert.equal(path.extname(store.buildDefaultSavePath()), '.mjstudio')
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true })
  }
}

testRecordFileExtensions()
testRecoveryRecordLifecycle()
testRecoverySourcePathUsesLocalSessionMetadata()
testPreviousRecoveryRecordUsesTheNewExtension()
testLegacyRecoveryRecordIsMovedOutOfTheRecordsRoot()
testDefaultDirectoryIsCreatedBesideExecutableRoot()
console.log('game file store tests passed')
