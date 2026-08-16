export type DistributionValue = number | string

export type DistributionEntry = {
  value: DistributionValue
  probability: number
}

export type NumericPrediction = {
  distribution: DistributionEntry[]
  scalarValue: number | null
  scalarSource: 'point-estimate' | 'expected-value' | 'distribution' | null
}

type JsonObject = Record<string, unknown>

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function finiteJsonNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function distributionValue(value: unknown): DistributionValue | null {
  const numeric = finiteJsonNumber(value)
  if (numeric !== null) return numeric
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text || null
}

export function parseNumericPrediction(value: unknown): NumericPrediction {
  const source = objectValue(value)
  const distribution = Array.isArray(source.distribution)
    ? source.distribution.flatMap((rawEntry): DistributionEntry[] => {
      const entry = objectValue(rawEntry)
      const parsedValue = distributionValue(entry.value)
      if (parsedValue === null) return []
      const rawProbability = finiteJsonNumber(entry.probability) ?? 0
      return [{
        value: parsedValue,
        probability: Math.max(0, Math.min(1, rawProbability)),
      }]
    })
    : []

  const pointEstimate = finiteJsonNumber(source.pointEstimate)
  if (pointEstimate !== null) {
    return { distribution, scalarValue: pointEstimate, scalarSource: 'point-estimate' }
  }

  const expectedValue = finiteJsonNumber(source.expectedValue)
  if (expectedValue !== null) {
    return { distribution, scalarValue: expectedValue, scalarSource: 'expected-value' }
  }

  if (distribution.length && distribution.every((entry) => typeof entry.value === 'number')) {
    return {
      distribution,
      scalarValue: distribution.reduce((sum, entry) => sum + ((entry.value as number) * entry.probability), 0),
      scalarSource: 'distribution',
    }
  }

  return { distribution, scalarValue: null, scalarSource: null }
}
