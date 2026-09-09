const { buildRuntimeMetrics } = require('../runtime-metrics')

function createRuntimeMetricsCollector({
  app,
  backendGateway,
  logger = console,
  getSystemMemoryInfo = () => process.getSystemMemoryInfo(),
}) {
  let previousBackendError = ''

  return async function collectRuntimeMetrics() {
    let backendMetrics = null
    try {
      const response = await backendGateway.getRuntimeMetrics()
      backendMetrics = response?.metrics || null
      previousBackendError = ''
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== previousBackendError) {
        logger.warn(`[runtime-metrics] backend metrics unavailable: ${message}`)
        previousBackendError = message
      }
    }
    return buildRuntimeMetrics({
      processMetrics: app.getAppMetrics(),
      backendMetrics,
      systemMemory: getSystemMemoryInfo(),
    })
  }
}

module.exports = { createRuntimeMetricsCollector }
