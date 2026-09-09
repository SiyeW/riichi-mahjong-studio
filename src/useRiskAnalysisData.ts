import { computed } from 'vue'
import type { AnalysisPanelDataProps, TileSource } from './analysisPanelTypes.ts'
import {
  adaptiveProbabilityScale,
  clampProbability,
  DEFAULT_PROBABILITY_SCALE,
  probabilityScaleRatio,
  probabilityScaleTicks,
} from './analysisProbabilityScale.ts'
import { ANALYSIS_TILE_ROWS } from './analysisTiles.ts'
import { analysisRecord, useAnalysisOutputs } from './useAnalysisOutputs.ts'

export function useRiskAnalysisData(props: AnalysisPanelDataProps) {
  const { playerOutput } = useAnalysisOutputs(() => props.analysis)
  const opponentSources = computed<TileSource[]>(() => props.analysisOpponents.map((opponent) => ({
    key: opponent.key,
    label: opponent.label,
    seat: opponent.seat,
  })))
  function riskProbability(seat: number | null, tile: string): number {
    if (seat === null) return 0
    const player = playerOutput('opponent-deal-in-probability', seat)
    return clampProbability(analysisRecord(player.tiles)[tile])
  }
  const riskScale = computed(() => adaptiveProbabilityScale(
    opponentSources.value.flatMap((source) => ANALYSIS_TILE_ROWS.flatMap((row) => (
      row.map((tile) => riskProbability(source.seat, tile))
    ))),
  ))
  const showRiskAdaptiveThreshold = computed(() => riskScale.value > DEFAULT_PROBABILITY_SCALE)
  const riskScaleTicks = computed(() => probabilityScaleTicks(riskScale.value))
  function riskBarScale(value: number): number {
    return probabilityScaleRatio(value, riskScale.value)
  }
  function riskScalePosition(value: number): string {
    return `${riskBarScale(value) * 100}%`
  }
  return {
    opponentSources,
    riskProbability,
    riskScale,
    showRiskAdaptiveThreshold,
    riskScaleTicks,
    riskBarScale,
    riskScalePosition,
  }
}
