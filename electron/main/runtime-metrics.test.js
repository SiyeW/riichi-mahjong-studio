const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
  buildRuntimeMetrics,
  collectElectronResidentBytes,
} = require('./runtime-metrics')

test('sums only Electron working sets, never mixing committed/private bytes', () => {
  assert.equal(collectElectronResidentBytes([
    { memory: { privateBytes: 100, workingSetSize: 500 } },
    { memory: { privateBytes: 200, workingSetSize: 600 } },
  ]), 1100 * 1024)

  assert.equal(collectElectronResidentBytes([
    { memory: { workingSetSize: 125 } },
  ]), 125 * 1024)
  assert.equal(collectElectronResidentBytes([{ memory: { privateBytes: 123 } }]), null)
  assert.equal(collectElectronResidentBytes([]), null)
})

test('combines Electron, backend, and engine memory', () => {
  assert.deepEqual(buildRuntimeMetrics({
    processMetrics: [
      { memory: { workingSetSize: 100 } },
      { memory: { workingSetSize: 200 } },
    ],
    backendMetrics: {
      memoryBasis: 'resident', backendResidentBytes: 400 * 1024,
      engineResidentBytes: 500 * 1024, codecResidentBytes: 0,
      engineProcessCount: 2,
    },
    systemMemory: {
      free: 1_000,
      total: 2_000,
    },
    sampledAt: 123,
  }), {
    memoryBasis: 'resident', applicationBytes: 1_200 * 1024,
    electronBytes: 300 * 1024,
    backendBytes: 400 * 1024,
    engineBytes: 500 * 1024,
    codecBytes: 0,
    recordCache: null,
    backendAvailable: true,
    electronProcessCount: 2,
    engineProcessCount: 2,
    systemAvailableBytes: 1_000 * 1024,
    systemTotalBytes: 2_000 * 1024,
    sampledAt: 123,
  })
})

test('does not report an incomplete total while the backend is unavailable', () => {
  const partial = buildRuntimeMetrics({
    processMetrics: [{ memory: { workingSetSize: 256 } }],
    systemMemory: { available: 3_000, free: 1_000, total: 4_000 },
  })
  assert.equal(partial.applicationBytes, null)
  assert.equal(partial.backendAvailable, false)
  assert.equal(partial.systemAvailableBytes, 3_000 * 1024)
})

test('codec memory belongs in the application total but not engine memory', () => {
  const recordCache = { residentBytes: 16, budgetBytes: 32 }
  const result = buildRuntimeMetrics({ processMetrics: [{ memory: { workingSetSize: 0 } }], backendMetrics: {
    memoryBasis: 'resident', backendResidentBytes: 100, engineResidentBytes: 200, codecResidentBytes: 50, recordCache,
  } })
  assert.equal(result.applicationBytes, 350)
  assert.equal(result.engineBytes, 200)
  assert.equal(result.codecBytes, 50)
  assert.deepEqual(result.recordCache, recordCache)
})

test('partial or incompatible process readings cannot invent a complete program total', () => {
  for (const backend of [null, { backendPrivateBytes: 5 },
    { memoryBasis: 'resident', backendResidentBytes: 10, engineResidentBytes: null, codecResidentBytes: 0 }]) {
    assert.equal(buildRuntimeMetrics({ processMetrics: [{ memory: { workingSetSize: 1 } }], backendMetrics: backend }).applicationBytes, null)
  }
  assert.equal(buildRuntimeMetrics().systemTotalBytes, null)
})
