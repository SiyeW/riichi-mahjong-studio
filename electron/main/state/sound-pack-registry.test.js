const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  discoverSoundPacks,
  publicSoundPackCatalog,
  resolveSoundPackFile,
  validateSoundPackManifest,
} = require('./sound-pack-registry')

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function soundPack(id, name, ponFile) {
  return {
    schemaVersion: 1,
    id,
    name,
    version: '1.0.0',
    sounds: {
      'tile.discard': 'sounds/shared.wav',
      'call.pon': ponFile,
    },
  }
}

function testSharedFilesAcrossTwoManifests() {
  const portableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-sound-packs-'))
  try {
    const packageRoot = path.join(portableDir, '.mjai-runtime', 'sound-packs', 'test')
    fs.mkdirSync(path.join(packageRoot, 'sounds'), { recursive: true })
    fs.writeFileSync(path.join(packageRoot, 'sounds', 'shared.wav'), 'shared')
    fs.writeFileSync(path.join(packageRoot, 'sounds', 'male.wav'), 'male')
    fs.writeFileSync(path.join(packageRoot, 'sounds', 'female.wav'), 'female')
    writeJson(
      path.join(packageRoot, 'male.soundpack.json'),
      soundPack('local.test.male', 'Test Male', 'sounds/male.wav'),
    )
    writeJson(
      path.join(packageRoot, 'female.soundpack.json'),
      soundPack('local.test.female', 'Test Female', 'sounds/female.wav'),
    )

    const catalog = discoverSoundPacks({
      appDir: portableDir,
      portableDir,
      resourceDir: portableDir,
      isPackaged: false,
    })
    assert.equal(catalog.packs.length, 2)
    assert.deepEqual(catalog.diagnostics, [])
    assert.equal(catalog.packs.every((pack) => pack.builtIn === false), true)
    assert.equal(
      resolveSoundPackFile(catalog, 'local.test.male', 'tile.discard'),
      path.join(packageRoot, 'sounds', 'shared.wav'),
    )
    const publicCatalog = publicSoundPackCatalog(catalog)
    assert.equal(
      publicCatalog.packs.find((pack) => pack.id === 'local.test.female')
        .sounds['call.pon'],
      'rms-sound://audio/local.test.female/call.pon',
    )
  } finally {
    fs.rmSync(portableDir, { recursive: true, force: true })
  }
}

function testUnsafeAndUnsupportedPathsAreRejected() {
  const unsafe = soundPack('local.test.unsafe', 'Unsafe', '../outside.wav')
  assert.ok(validateSoundPackManifest(unsafe).some((error) => error.includes('safe relative path')))
  const unsupported = soundPack('local.test.unsupported', 'Unsupported', 'sounds/voice.exe')
  assert.ok(validateSoundPackManifest(unsupported).some((error) => error.includes('unsupported file type')))
}

testSharedFilesAcrossTwoManifests()
testUnsafeAndUnsupportedPathsAreRejected()
console.log('sound pack registry tests passed')
