export type AnalysisCountSpacing = Readonly<{
  tileGapPixels: number
  wallGapPixels: number
}>

export const ANALYSIS_COUNT_TILE_GAP_MAX = 8
export const ANALYSIS_COUNT_WALL_GAP_MAX = 12

export const DEFAULT_ANALYSIS_COUNT_SPACING: AnalysisCountSpacing = Object.freeze({
  tileGapPixels: 2,
  wallGapPixels: 2,
})

function normalizePhysicalPixels(value: unknown, maximum: number, fallback: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(0, Math.min(maximum, Math.round(numeric)))
}

export function normalizeAnalysisCountSpacing(value: AnalysisCountSpacing): AnalysisCountSpacing {
  return {
    tileGapPixels: normalizePhysicalPixels(
      value.tileGapPixels,
      ANALYSIS_COUNT_TILE_GAP_MAX,
      DEFAULT_ANALYSIS_COUNT_SPACING.tileGapPixels,
    ),
    wallGapPixels: normalizePhysicalPixels(
      value.wallGapPixels,
      ANALYSIS_COUNT_WALL_GAP_MAX,
      DEFAULT_ANALYSIS_COUNT_SPACING.wallGapPixels,
    ),
  }
}
