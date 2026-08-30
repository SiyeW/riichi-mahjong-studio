export type AnalysisCountSpacing = Readonly<{
  tileGapPixels: number
  wallGapPixels: number
}>

export type AnalysisCountLayout = 'tile-groups' | 'source-rows'

export const DEFAULT_ANALYSIS_COUNT_LAYOUT: AnalysisCountLayout = 'tile-groups'

export const ANALYSIS_COUNT_SPACING: Readonly<Record<AnalysisCountLayout, AnalysisCountSpacing>> = Object.freeze({
  'tile-groups': Object.freeze({ tileGapPixels: 6, wallGapPixels: 0 }),
  'source-rows': Object.freeze({ tileGapPixels: 1, wallGapPixels: 0 }),
})
