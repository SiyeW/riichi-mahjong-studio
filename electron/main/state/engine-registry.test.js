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

testFreshRegistryIsEmpty()
testInstalledPackageRefreshesProfileIdentity()
console.log('engine registry tests passed')
