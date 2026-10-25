import type { RuntimeMetrics } from './contracts/runtime'

export interface ResourceRow {
  id: string
  labelKey: string
  bytes: number | null
  fraction: number | null
}

export interface ResourceGroup {
  id: 'application' | 'system' | 'cache'
  titleKey: string
  referenceKey: string
  referenceBytes: number | null
  scaleBytes: number | null
  rows: ResourceRow[]
}

function validBytes(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null
}

function group(id: ResourceGroup['id'], titleKey: string, referenceKey: string,
  reference: number | null | undefined, values: Array<[string, string, number | null | undefined]>,
  expandScale = false): ResourceGroup {
  const referenceBytes = validBytes(reference)
  const rows = values.map(([id, labelKey, value]) => ({ id, labelKey, bytes: validBytes(value) }))
  const scaleBytes = referenceBytes != null && referenceBytes > 0
    ? Math.max(referenceBytes, ...(expandScale ? rows.map(row => row.bytes ?? 0) : []))
    : null
  return {
    id, titleKey, referenceKey, referenceBytes, scaleBytes,
    rows: rows.map(row => ({ ...row,
      fraction: row.bytes != null && scaleBytes != null && row.bytes <= scaleBytes
        ? row.bytes / scaleBytes : null,
    })),
  }
}

// Working sets can count shared pages more than once. System rows are independent
// comparisons, not a partition; protected/pending cache memory is not additive.
export function runtimeResourceGroups(metrics: RuntimeMetrics | null): ResourceGroup[] {
  if (!metrics) return []
  const total = validBytes(metrics.systemTotalBytes)
  const available = validBytes(metrics.systemAvailableBytes)
  const validSystem = total != null && total > 0 && available != null && available <= total
  const resident = metrics.memoryBasis === 'resident'
  const application = resident ? metrics.applicationBytes : null
  const groups = [
    group('system', 'status.systemMemory', 'status.resourceTotal', total, [
      ['used', 'status.systemUsed', validSystem ? total - available : null],
      ['application', 'status.applicationResident', application],
      ['available', 'status.systemFree', validSystem ? available : null],
    ]),
    group('application', 'status.applicationBreakdown', 'status.resourceTotal', application, [
      ['electron', 'status.electron', resident ? metrics.electronBytes : null],
      ['backend', 'status.pythonBackend', resident ? metrics.backendBytes : null],
      ['engines', 'status.engines', resident ? metrics.engineBytes : null],
      ['codec', 'status.recordCodec', resident ? metrics.codecBytes : null],
    ]),
  ]
  const cache = metrics.recordCache
  if (cache) {
    const values: Array<[string, string, number]> = [
      ['resident', 'status.cacheResident', cache.residentBytes],
      ['protected', 'status.cacheProtected', cache.protectedBytes],
      ['pending', 'status.cachePendingBytes', cache.encodedPendingBytes],
    ]
    if (validBytes(cache.protectedOvershootBytes)) {
      values.push(['overshoot', 'status.cacheOvershoot', cache.protectedOvershootBytes])
    }
    groups.push(group('cache', 'status.analysisCache', 'status.resourceBudget', cache.budgetBytes, values, true))
  }
  return groups
}
