function kilobytesToBytes(value) {
  const normalized = Number(value)
  return Number.isFinite(normalized) && normalized > 0
    ? Math.round(normalized * 1024)
    : 0
}

function collectElectronPrivateBytes(processMetrics = []) {
  return processMetrics.reduce((total, metric) => {
    const memory = metric?.memory || {}
    const privateKilobytes = Number(memory.privateBytes)
    const workingSetKilobytes = Number(memory.workingSetSize)
    return total + kilobytesToBytes(
      Number.isFinite(privateKilobytes) && privateKilobytes >= 0
        ? privateKilobytes
        : workingSetKilobytes,
    )
  }, 0)
}

function buildRuntimeMetrics({
  processMetrics = [],
  backendMetrics = null,
  systemMemory = {},
  sampledAt = Date.now(),
} = {}) {
  const electronBytes = collectElectronPrivateBytes(processMetrics)
  const backendBytes = Math.max(0, Number(backendMetrics?.backendPrivateBytes) || 0)
  const engineBytes = Math.max(0, Number(backendMetrics?.enginePrivateBytes) || 0)
  const backendAvailable = Boolean(backendMetrics)
  const availableKilobytes = Number.isFinite(Number(systemMemory.available))
    ? Number(systemMemory.available)
    : Number(systemMemory.free)

  return {
    applicationBytes: backendAvailable
      ? electronBytes + backendBytes + engineBytes
      : null,
    electronBytes,
    backendBytes: backendAvailable ? backendBytes : null,
    engineBytes: backendAvailable ? engineBytes : null,
    backendAvailable,
    electronProcessCount: Array.isArray(processMetrics) ? processMetrics.length : 0,
    engineProcessCount: backendAvailable
      ? Math.max(0, Number(backendMetrics.engineProcessCount) || 0)
      : null,
    systemAvailableBytes: kilobytesToBytes(availableKilobytes),
    systemTotalBytes: kilobytesToBytes(systemMemory.total),
    sampledAt,
  }
}

module.exports = {
  buildRuntimeMetrics,
  collectElectronPrivateBytes,
}
