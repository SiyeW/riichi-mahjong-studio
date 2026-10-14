import { computed, onBeforeUnmount, ref } from 'vue'
import type { RuntimeMetrics } from './contracts/runtime'

type Translate = (key: string, params?: Record<string, string | number>) => string

export function useRuntimeMetrics(t: Translate) {
  const runtimeMetrics = ref<RuntimeMetrics | null>(null)
  let runtimeMetricsTimer: number | null = null
  let runtimeMetricsRequestInFlight = false

  function formatMemorySize(value: number | null | undefined) {
    if (value === null || value === undefined) return '—'
    const bytes = Number(value)
    if (!Number.isFinite(bytes) || bytes < 0) return '—'
    const gibibytes = bytes / (1024 ** 3)
    if (gibibytes >= 1) return `${gibibytes.toFixed(gibibytes < 10 ? 2 : 1)} GB`
    const mebibytes = bytes / (1024 ** 2)
    return `${Math.round(mebibytes)} MB`
  }

  const runtimeMemoryRows = computed(() => {
    const metrics = runtimeMetrics.value
    if (!metrics) return [{ label: t('status.memoryInfo'), value: t('status.reading') }]
    const engineCount = metrics.engineProcessCount === null
      ? ''
      : t('status.engineProcesses', { count: metrics.engineProcessCount })
    return [
      { label: 'Electron', value: formatMemorySize(metrics.electronBytes) },
      { label: t('status.pythonBackend'), value: formatMemorySize(metrics.backendBytes) },
      { label: t('status.engines', { count: engineCount }), value: formatMemorySize(metrics.engineBytes) },
      { label: t('status.recordCodec'), value: formatMemorySize(metrics.codecBytes) },
      { label: t('status.systemTotal'), value: formatMemorySize(metrics.systemTotalBytes) },
      ...(metrics.recordCache ? [
        { label: t('status.analysisCache'), value: `${formatMemorySize(metrics.recordCache.residentBytes)} / ${formatMemorySize(metrics.recordCache.budgetBytes)}` },
        { label: t('status.cacheProtected'), value: formatMemorySize(metrics.recordCache.protectedBytes) },
        { label: t('status.cachePending'), value: `${metrics.recordCache.pendingResults} · ${formatMemorySize(metrics.recordCache.encodedPendingBytes)}` },
        ...(metrics.recordCache.error ? [{ label: t('status.recoveryError'), value: metrics.recordCache.error }] : []),
      ] : []),
    ]
  })

  async function refreshRuntimeMetrics() {
    if (!window.studioAPI?.getRuntimeMetrics || runtimeMetricsRequestInFlight) return
    runtimeMetricsRequestInFlight = true
    try {
      runtimeMetrics.value = await window.studioAPI.getRuntimeMetrics()
    } catch {
      // Keep the last successful sample while the backend or application is restarting.
    } finally {
      runtimeMetricsRequestInFlight = false
    }
  }

  function startRuntimeMetrics() {
    void refreshRuntimeMetrics()
    if (runtimeMetricsTimer !== null) return
    runtimeMetricsTimer = window.setInterval(() => {
      void refreshRuntimeMetrics()
    }, 2000)
  }

  function stopRuntimeMetrics() {
    if (runtimeMetricsTimer === null) return
    window.clearInterval(runtimeMetricsTimer)
    runtimeMetricsTimer = null
  }

  onBeforeUnmount(stopRuntimeMetrics)

  return {
    runtimeMetrics,
    runtimeMemoryRows,
    formatMemorySize,
    startRuntimeMetrics,
  }
}
