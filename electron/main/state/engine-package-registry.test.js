const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  discoverEnginePackages,
  publicEngineCatalog,
  validateEngineManifest,
} = require('./engine-package-registry')

const projectRoot = path.resolve(__dirname, '..', '..', '..')

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function customEngine(id = 'third-party.test-engine') {
  return {
    schemaVersion: 2,
    id,
    name: 'Test Engine',
    version: '1.2.3',
    sourceUrl: 'https://example.com/source',
    protocol: { name: 'riichi-engine-protocol', major: 2, minor: 0 },
    entrypoints: {
      'windows-x64': {
        executable: 'runtime/test-engine.exe',
        arguments: ['--stdio'],
      },
    },
    licenses: [{ name: 'Test license', path: 'LICENSE' }],
    notices: [{ name: 'Third-party notices', path: 'THIRD_PARTY_NOTICES.md' }],
  }
}

function createPackage(root, manifest = customEngine(), withExecutable = true) {
  writeJson(path.join(root, 'engine.json'), manifest)
  if (withExecutable) {
    const executablePath = path.join(root, 'runtime', 'test-engine.exe')
    fs.mkdirSync(path.dirname(executablePath), { recursive: true })
    fs.writeFileSync(executablePath, 'mock executable')
  }
  fs.writeFileSync(path.join(root, 'LICENSE'), 'test license')
  fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'test notices')
}

function testEmptyPublicCatalog() {
  const catalog = discoverEnginePackages({
    appDir: projectRoot,
    portableDir: projectRoot,
    resourceDir: projectRoot,
  })
  assert.deepEqual(catalog.engines, [])
  assert.deepEqual(catalog.diagnostics, [])
  assert.equal('models' in publicEngineCatalog(catalog), false)
}

function testPortablePackagesAndDuplicatePrecedence() {
  const portableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-engine-registry-'))
  try {
    createPackage(path.join(portableDir, 'engines', 'test'))
    writeJson(path.join(portableDir, 'engines', 'z-duplicate', 'engine.json'), customEngine())
    const catalog = discoverEnginePackages({ appDir: projectRoot, portableDir, resourceDir: projectRoot })
    assert.ok(catalog.diagnostics.some((item) => item.code === 'engine-id-duplicate'))
    const publicEngine = publicEngineCatalog(catalog).engines.find(
      (engine) => engine.id === 'third-party.test-engine',
    )
    assert.equal(publicEngine.launch.cwd, path.join(portableDir, 'engines', 'test'))
    assert.equal(publicEngine.launch.arguments[0], '--stdio')
    assert.ok(path.isAbsolute(publicEngine.launch.executable))
    assert.deepEqual(publicEngine.protocol, {
      name: 'riichi-engine-protocol', major: 2, minor: 0,
    })
    assert.deepEqual(publicEngine.licenses, [{ name: 'Test license', available: true }])
    assert.deepEqual(publicEngine.notices, [{ name: 'Third-party notices', available: true }])
  } finally {
    fs.rmSync(portableDir, { recursive: true, force: true })
  }
}

function testMissingExecutableMakesPackageUnavailable() {
  const portableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-engine-registry-'))
  try {
    createPackage(path.join(portableDir, 'engines', 'test'), customEngine(), false)
    const catalog = discoverEnginePackages({ appDir: projectRoot, portableDir, resourceDir: projectRoot })
    assert.ok(catalog.diagnostics.some((item) => item.code === 'engine-executable-missing'))
    assert.equal(publicEngineCatalog(catalog).engines[0].launch, null)
  } finally {
    fs.rmSync(portableDir, { recursive: true, force: true })
  }
}

function testExternalEngineRootsFromEnvironment() {
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-external-engine-'))
  try {
    createPackage(externalRoot)
    const catalog = discoverEnginePackages({
      appDir: projectRoot,
      portableDir: projectRoot,
      resourceDir: projectRoot,
      env: { MJAI_ENGINE_ROOTS: externalRoot },
    })
    assert.equal(catalog.engines[0].id, 'third-party.test-engine')
    assert.equal(catalog.engines[0].builtIn, false)
  } finally {
    fs.rmSync(externalRoot, { recursive: true, force: true })
  }
}

function testUnsafePathsAreRejected() {
  const engine = customEngine()
  engine.entrypoints['windows-x64'].executable = '../outside.exe'
  assert.ok(validateEngineManifest(engine).some((error) => error.includes('safe relative path')))
  const unsafeLicenseEngine = customEngine()
  unsafeLicenseEngine.licenses[0].path = '../LICENSE'
  assert.ok(validateEngineManifest(unsafeLicenseEngine).some((error) => error.includes('licenses entry path')))
}

testEmptyPublicCatalog()
testPortablePackagesAndDuplicatePrecedence()
testMissingExecutableMakesPackageUnavailable()
testExternalEngineRootsFromEnvironment()
testUnsafePathsAreRejected()
console.log('engine package registry tests passed')
