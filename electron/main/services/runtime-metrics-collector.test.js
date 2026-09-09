const assert = require('node:assert/strict')
const test = require('node:test')
const { createRuntimeMetricsCollector } = require('./runtime-metrics-collector')

function createApp() {
  return {
    getAppMetrics: () => [{ memory: { privateBytes: 1 } }],
    getSystemMemoryInfo: () => ({ total: 4096, free: 2048 }),
  }
}

test('runtime metrics collector combines Electron, system, and backend samples', async () => {
  const collect = createRuntimeMetricsCollector({
    app: createApp(),
    backendGateway: {
      getRuntimeMetrics: async () => ({
        metrics: {
          backendPrivateBytes: 2048,
          enginePrivateBytes: 4096,
          engineProcessCount: 2,
        },
      }),
    },
    getSystemMemoryInfo: () => ({ total: 4096, free: 2048 }),
  })

  const result = await collect()
  assert.equal(Number.isFinite(result.sampledAt), true)
  delete result.sampledAt
  assert.deepEqual(result, {
    applicationBytes: 7168,
    electronBytes: 1024,
    backendBytes: 2048,
    engineBytes: 4096,
    backendAvailable: true,
    electronProcessCount: 1,
    engineProcessCount: 2,
    systemTotalBytes: 4194304,
    systemAvailableBytes: 2097152,
  })
})

test('runtime metrics collector suppresses repeated backend warnings until recovery', async () => {
  const warnings = []
  let failure = 'offline'
  const collect = createRuntimeMetricsCollector({
    app: createApp(),
    backendGateway: {
      getRuntimeMetrics: async () => {
        if (failure) throw new Error(failure)
        return { metrics: null }
      },
    },
    logger: { warn: (message) => warnings.push(message) },
    getSystemMemoryInfo: () => ({ total: 4096, free: 2048 }),
  })

  await collect()
  await collect()
  failure = ''
  await collect()
  failure = 'offline'
  await collect()

  assert.deepEqual(warnings, [
    '[runtime-metrics] backend metrics unavailable: offline',
    '[runtime-metrics] backend metrics unavailable: offline',
  ])
})
