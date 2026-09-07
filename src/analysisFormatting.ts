import type { Ref } from 'vue'
import { clampProbability } from './analysisProbabilityScale.ts'
import type { DistributionValue } from './numericPrediction.ts'

export type AnalysisTranslator = (key: string, params?: Record<string, string | number>) => string

export function createAnalysisFormatting(t: AnalysisTranslator, numberLocale: Readonly<Ref<string>>) {
  function formatCompactPoints(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '—'
    return new Intl.NumberFormat(numberLocale.value, {
      notation: Math.abs(value) >= 10000 ? 'compact' : 'standard',
      maximumFractionDigits: 1,
    }).format(Math.round(value))
  }

  function formatPoints(value: number | null): string {
    return value === null || !Number.isFinite(value)
      ? t('analysis.noData')
      : t('analysis.points', { value: Math.round(value).toLocaleString(numberLocale.value) })
  }

  function formatPlainPoints(value: number | null): string {
    return value === null || !Number.isFinite(value) ? '—' : Math.round(value).toLocaleString(numberLocale.value)
  }

  function formatSignedCompactPoints(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return '—'
    const absolute = formatCompactPoints(Math.abs(value))
    return `${value > 0 ? '+' : value < 0 ? '−' : ''}${absolute}`
  }

  function formatDistributionPoints(value: DistributionValue): string {
    return typeof value === 'number' ? formatCompactPoints(value) : String(value)
  }

  function formatProbability(value: number): string {
    const percentage = clampProbability(value) * 100
    if (percentage === 0) return '0%'
    if (percentage < 0.01) return '<0.01%'
    return `${percentage.toFixed(1)}%`
  }

  return {
    formatCompactPoints,
    formatPoints,
    formatPlainPoints,
    formatSignedCompactPoints,
    formatDistributionPoints,
    formatProbability,
  }
}
