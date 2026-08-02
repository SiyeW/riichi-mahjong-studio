const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  discoverEnginePackages,
  publicEngineCatalog,
  validateEngineManifest,
  validateModelMetadata,
} = require('./engine-package-registry')

const projectRoot = path.resolve(__dirname, '..', '..', '..')

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function customEngine(id = 'third-party.test-engine') {
  return {
    schemaVersion: 1,
    id,
    name: 'Test Engine',
    version: '1.2.3',
    protocol: {
      name: 'riichi-engine-protocol',
      major: 1,
      minor: 0,
    },
    kinds: ['decision'],
    entrypoints: {
      'windows-x64': {
        executable: 'runtime/test-engine.exe',
        arguments: ['--stdio'],
      },
    },
    modelFormats: [{
      id: 'test-checkpoint',
      extensions: ['.bin'],
      inputSchema: 'test-input-v1',
      outputSchema: 'decision-v1',
    }],
    capabilities: {
      multipleSessions: true,
      incrementalHistory: false,
      cancellation: false,
      reload: true,
    },
  }
}

function customModel() {
  return {
    schemaVersion: 1,
    id: 'third-party.test-model',
    name: 'Test Model',
    engineId: 'third-party.test-engine',
    format: 'test-checkpoint',
    file: 'model.bin',
    sha256: '0'.repeat(64),
    sizeBytes: 3,
    inputSchema: 'test-input-v1',
    outputSchema: 'decision-v1',
  }
}

function testEmptyPublicCatalog() {
  const catalog = discoverEnginePackages({
    appDir: projectRoot,
    portableDir: projectRoot,
    resourceDir: projectRoot,
  })
  assert.deepEqual(catalog.engines, [])
  assert.deepEqual(catalog.models, [])
  assert.deepEqual(catalog.diagnostics, [])
}

function testPortablePackagesAndDuplicatePrecedence() {
  const portableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjai-engine-registry-'))
  try {
    writeJson(
      path.join(portableDir, 'engines', 'test', 'engine.json'),
      customEngine(),
    )
    const executablePath = path.join(
      portableDir,
      'engines',
      'test',
      'runtime',
      'test-engine.exe',
    )
    fs.mkdirSync(path.dirname(executablePath), { recursive: true })
    fs.writeFileSync(executablePath, 'mock executable')
    writeJson(
      path.join(portableDir, 'engines', 'z-duplicate', 'engine.json'),
      customEngine(),
    )
    const modelRoot = path.join(portableDir, 'engines', 'test')
    writeJson(path.join(modelRoot, 'model.json'), customModel())
    fs.writeFileSync(path.join(modelRoot, 'model.bin'), 'abc')

    const catalog = discoverEnginePackages({
      appDir: projectRoot,
      portableDir,
      resourceDir: projectRoot,
    })
    const custom = catalog.models.find((model) => model.id === 'third-party.test-model')
    assert.equal(custom.compatible, true)
    assert.equal(custom.builtIn, false)
    assert.ok(catalog.diagnostics.some((item) => item.code === 'engine-id-duplicate'))
    const publicCatalog = publicEngineCatalog(catalog)
    const launch = publicCatalog.engines.find(
      (engine) => engine.id === 'third-party.test-engine',
    ).launch
    assert.equal(launch.cwd, path.join(portableDir, 'engines', 'test'))
    assert.equal(launch.arguments[0], '--stdio')
    assert.ok(path.isAbsolute(launch.executable))
  } finally {
    fs.rmSync(portableDir, { recursive: true, force: true })
  }
}

function testMissingExecutableMakesPackageUnavailable() {
  const portableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjai-engine-registry-'))
  try {
    writeJson(
      path.join(portableDir, 'engines', 'test', 'engine.json'),
      customEngine(),
    )
    const modelRoot = path.join(portableDir, 'engines', 'test')
    writeJson(path.join(modelRoot, 'model.json'), customModel())
    fs.writeFileSync(path.join(modelRoot, 'model.bin'), 'abc')
    const catalog = discoverEnginePackages({
      appDir: projectRoot,
      portableDir,
      resourceDir: projectRoot,
    })
    assert.equal(
      catalog.models.find((model) => model.id === 'third-party.test-model').compatible,
      false,
    )
    assert.ok(
      catalog.diagnostics.some((item) => item.code === 'engine-executable-missing'),
    )
    assert.equal(
      publicEngineCatalog(catalog).engines.find(
        (engine) => engine.id === 'third-party.test-engine',
      ).launch,
      null,
    )
  } finally {
    fs.rmSync(portableDir, { recursive: true, force: true })
  }
}

function testUnsafePathsAreRejected() {
  const engine = customEngine()
  engine.entrypoints['windows-x64'].executable = '../outside.exe'
  assert.ok(validateEngineManifest(engine).some((error) => error.includes('safe relative path')))

  const model = customModel()
  model.file = 'C:/outside.bin'
  assert.ok(validateModelMetadata(model).some((error) => error.includes('safe relative path')))
}

testEmptyPublicCatalog()
testPortablePackagesAndDuplicatePrecedence()
testMissingExecutableMakesPackageUnavailable()
testUnsafePathsAreRejected()
console.log('engine package registry tests passed')
