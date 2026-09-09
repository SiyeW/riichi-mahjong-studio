import type { AnalysisCountLayout } from './analysisCountSpacing.ts'
import type { PerceptualSurfaceBinding } from './perceptualSurface.ts'
import type { CountSourceKey } from './analysisCountPalette.ts'
import type { AnalysisRecord } from './useAnalysisOutputs.ts'

export type AnalysisPanelSection = 'opponents' | 'game' | 'risk' | 'counts'

export type AnalysisOpponent = {
  key: Exclude<CountSourceKey, 'wall'>
  seat: number
  label: string
  probabilities: number[]
}

export type TileSource = { key: CountSourceKey; label: string; seat: number | null }

export interface AnalysisPanelDataProps {
  analysis: AnalysisRecord | null | undefined
  analysisOpponents: AnalysisOpponent[]
  controlledSeat: number
  dealer: number
}

export interface AnalysisPanelProps extends AnalysisPanelDataProps {
  section: AnalysisPanelSection
  shantenColors: string[]
  shantenLabels: string[]
  shantenShortLabels: string[]
  reduceMotion: boolean
  tileImageSrc: (tile: string) => string
  tileFaceLabel: (tile: string) => string
  perceptualSurface: PerceptualSurfaceBinding
  countLayout: AnalysisCountLayout
}
