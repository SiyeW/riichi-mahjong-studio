const assert = require('node:assert/strict')
const { test } = require('node:test')

const {
  buildRuntimeMetrics,
  collectElectronPrivateBytes,
} = require('./runtime-metrics')

test('sums Electron private memory and falls back to the working set', () => {
  assert.equal(collectElectronPrivateBytes([
    { memory: { privateBytes: 100, workingSetSize: 500 } },
    { memory: { privateBytes: 200, workingSetSize: 600 } },
  ]), 300 * 1024)

  assert.equal(collectElectronPrivateBytes([
    { memory: { workingSetSize: 125 } },
  ]), 125 * 1024)
})

test('combines Electron, backend, and engine memory', () => {
  assert.deepEqual(buildRuntimeMetrics({
    processMetrics: [
      { memory: { privateBytes: 100 } },
      { memory: { privateBytes: 200 } },
    ],
    backendMetrics: {
      backendPrivateBytes: 400 * 1024,
      enginePrivateBytes: 500 * 1024,
      engineProcessCount: 2,
    },
    systemMemory: {
      free: 1_000,
      total: 2_000,
    },
    sampledAt: 123,
  }), {
    applicationBytes: 1_200 * 1024,
    electronBytes: 300 * 1024,
    backendBytes: 400 * 1024,
    engineBytes: 500 * 1024,
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
    processMetrics: [{ memory: { privateBytes: 256 } }],
    systemMemory: { available: 3_000, free: 1_000, total: 4_000 },
  })
  assert.equal(partial.applicationBytes, null)
  assert.equal(partial.backendAvailable, false)
  assert.equal(partial.systemAvailableBytes, 3_000 * 1024)
})
