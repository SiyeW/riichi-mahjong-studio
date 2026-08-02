const assert = require('node:assert/strict')

const {
  buildLegacyModels,
  normalizeEngineSettings,
} = require('./engine-registry')

function testFreshRegistryIsEmpty() {
  const engines = normalizeEngineSettings()
  assert.deepEqual(engines.decisionProfiles, [])
  assert.deepEqual(engines.opponentAnalysisProfiles, [])
  assert.equal(engines.selectedDecisionProfileId, '')
  assert.equal(engines.selectedOpponentAnalysisProfileId, '')
  const legacy = buildLegacyModels(engines)
  assert.equal(legacy.teachingModel.engineId, '')
  assert.equal(legacy.teachingModel.modelPath, '')
  assert.equal(legacy.opponentAnalysis.engineId, '')
}

function testInstalledPackageRefreshesProfileIdentity() {
  const catalog = {
    engines: [{
      id: 'example.decision',
      version: '2.0.0',
      executablePath: 'C:\\engine\\engine.exe',
      packageRoot: 'C:\\engine',
      launchAvailable: true,
      manifest: { entrypoints: { 'windows-x64': { arguments: ['--jsonl'] } } },
    }],
    models: [{
      id: 'example.model',
      compatible: true,
      runtimePath: 'C:\\engine\\model.onnx',
      metadata: { format: 'example-onnx', sha256: 'a'.repeat(64) },
    }],
  }
  const engines = normalizeEngineSettings({
    selectedDecisionProfileId: 'profile.example',
    decisionProfiles: [{
      id: 'profile.example',
      name: 'Example',
      engineId: 'example.decision',
      modelId: 'example.model',
      options: { temperature: 0 },
    }],
    opponentAnalysisProfiles: [],
  }, null, catalog)
  const profile = engines.decisionProfiles[0]
  assert.equal(profile.available, true)
  assert.equal(profile.engineVersion, '2.0.0')
  assert.equal(profile.modelFormat, 'example-onnx')
  assert.equal(profile.options.temperature, 0)
  assert.deepEqual(profile.engineCommand, ['C:\\engine\\engine.exe', '--jsonl'])
}

testFreshRegistryIsEmpty()
testInstalledPackageRefreshesProfileIdentity()
console.log('engine registry tests passed')
