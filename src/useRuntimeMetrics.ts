import { onBeforeUnmount, ref } from 'vue'
import type { RuntimeMetrics } from './contracts/runtime'

export function useRuntimeMetrics() {
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
    formatMemorySize,
    startRuntimeMetrics,
  }
}
