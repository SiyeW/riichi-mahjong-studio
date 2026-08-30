import type { DistributionEntry } from './numericPrediction'

export type CountTooltipEntry = {
  count: number
  probability: number
  color: string
}

export function countTooltipDistribution(
  distribution: readonly DistributionEntry[],
  redFive: boolean,
  palette: readonly string[],
): CountTooltipEntry[] {
  const counts = redFive ? [0, 1] : [0, 1, 2, 3, 4]
  const entries = counts.map((count) => ({
    count,
    probability: distribution.find((entry) => entry.value === count)?.probability || 0,
    color: palette[count],
  }))
  const total = entries.reduce((sum, entry) => sum + entry.probability, 0)
  if (total <= 0) return []
  return entries.map((entry) => ({ ...entry, probability: entry.probability / total }))
}
