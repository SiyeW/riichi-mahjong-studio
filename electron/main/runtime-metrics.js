function kilobytesToBytes(value) {
  const normalized = knownBytes(value)
  return normalized !== null
    ? Math.round(normalized * 1024)
    : null
}

function knownBytes(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function completeTotal(values) {
  return values.every(value => value !== null) ? values.reduce((sum, value) => sum + value, 0) : null
}

function collectElectronResidentBytes(processMetrics = []) {
  if (!Array.isArray(processMetrics) || !processMetrics.length) return null
  return completeTotal(processMetrics.map(metric => kilobytesToBytes(metric?.memory?.workingSetSize)))
}

function buildRuntimeMetrics({
  processMetrics = [],
  backendMetrics = null,
  systemMemory = {},
  sampledAt = Date.now(),
} = {}) {
  const electronBytes = collectElectronResidentBytes(processMetrics)
  const backendAvailable = backendMetrics?.memoryBasis === 'resident'
  const backendBytes = backendAvailable ? knownBytes(backendMetrics.backendResidentBytes) : null
  const engineBytes = backendAvailable ? knownBytes(backendMetrics.engineResidentBytes) : null
  const codecBytes = backendAvailable ? knownBytes(backendMetrics.codecResidentBytes) : null
  const availableKilobytes = knownBytes(systemMemory.available) ?? knownBytes(systemMemory.free)

  return {
    memoryBasis: 'resident',
    applicationBytes: completeTotal([electronBytes, backendBytes, engineBytes, codecBytes]),
    electronBytes,
    backendBytes: backendAvailable ? backendBytes : null,
    engineBytes: backendAvailable ? engineBytes : null,
    codecBytes: backendAvailable ? codecBytes : null,
    recordCache: backendMetrics?.recordCache || null,
    backendAvailable,
    electronProcessCount: Array.isArray(processMetrics) ? processMetrics.length : 0,
    engineProcessCount: backendAvailable
      ? knownBytes(backendMetrics.engineProcessCount)
      : null,
    systemAvailableBytes: kilobytesToBytes(availableKilobytes),
    systemTotalBytes: kilobytesToBytes(systemMemory.total),
    sampledAt,
  }
}

module.exports = {
  buildRuntimeMetrics,
  collectElectronResidentBytes,
}
