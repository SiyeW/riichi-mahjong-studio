const assert = require('node:assert/strict')

const { normalizeEngineSettings } = require('./engine-registry')

function testFreshRegistryIsEmpty() {
  const engines = normalizeEngineSettings()
  assert.deepEqual(engines.profiles, [])
  assert.deepEqual(engines.loadedProfileIds, [])
  assert.deepEqual(engines.outputAssignments, {
    'action-recommendation': '',
    'opponent-shanten': '',
    'opponent-deal-in-probability': '',
    'opponent-concealed-tile-count': '',
    'wall-tile-count': '',
    'opponent-dora-count': '',
    'opponent-score': '',
    'kyoku-outcome': '',
    'kyoku-score-delta': '',
    'match-placement': '',
    'match-score': '',
  })
}

function testInstalledPackageRefreshesProfileIdentity() {
  const catalog = {
    engines: [{
      id: 'example.engine',
      version: '2.0.0',
      executablePath: 'C:\\engine\\engine.exe',
      packageRoot: 'C:\\engine',
      launchAvailable: true,
      manifest: { entrypoints: { 'windows-x64': { arguments: ['--jsonl'] } } },
    }],
  }
  const engines = normalizeEngineSettings({
    profiles: [{
      id: 'profile.example',
      name: 'Example',
      engineId: 'example.engine',
      weights: [{ slotId: 'model', format: 'example-onnx', path: 'C:\\engine\\model.onnx' }],
      device: 'cpu',
      options: { temperature: 0 },
    }],
    outputAssignments: {
      'action-recommendation': 'profile.example',
      'opponent-shanten': '',
      'opponent-deal-in-probability': '',
    },
    loadedProfileIds: ['profile.example', 'profile.missing', 'profile.example'],
  }, null, catalog)
  const profile = engines.profiles[0]
  assert.equal(profile.available, true)
  assert.equal(profile.engineVersion, '2.0.0')
  assert.equal(profile.weights[0].format, 'example-onnx')
  assert.equal(profile.options.temperature, 0)
  assert.deepEqual(profile.engineCommand, ['C:\\engine\\engine.exe', '--jsonl'])
  assert.equal(engines.outputAssignments['action-recommendation'], profile.id)
  assert.deepEqual(engines.loadedProfileIds, ['profile.example'])
}

function testExplicitExecutableDoesNotFollowAnotherPackageWithTheSameEngineId() {
  const catalog = {
    engines: [{
      id: 'example.engine',
      version: '1.0.0',
      executablePath: 'C:\\installed\\engine.exe',
      packageRoot: 'C:\\installed',
      launchAvailable: true,
    }],
  }
  const [profile] = normalizeEngineSettings({
    profiles: [{
      id: 'profile.preview',
      engineId: 'example.engine',
      enginePath: 'C:\\preview\\engine.exe',
      engineCommand: ['C:\\preview\\engine.exe'],
      engineCwd: 'C:\\preview',
      engineVersion: '2.0.0-preview',
    }],
  }, null, catalog).profiles
  assert.equal(profile.enginePath, 'C:\\preview\\engine.exe')
  assert.deepEqual(profile.engineCommand, ['C:\\preview\\engine.exe'])
  assert.equal(profile.engineCwd, 'C:\\preview')
  assert.equal(profile.engineVersion, '2.0.0-preview')
}

testFreshRegistryIsEmpty()
testInstalledPackageRefreshesProfileIdentity()
testExplicitExecutableDoesNotFollowAnotherPackageWithTheSameEngineId()
console.log('engine registry tests passed')
