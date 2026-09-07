import { computed } from 'vue'
import type { AnalysisPanelDataProps, TileSource } from './analysisPanelTypes.ts'
import { hasRedFiveCountPredictions } from './analysisTileCounts.ts'
import { analysisCountSourceTiles, analysisCountTileRows, isRedFiveTile } from './analysisTiles.ts'
import { parseNumericPrediction, type DistributionEntry, type NumericPrediction } from './numericPrediction.ts'
import { analysisRecord, useAnalysisOutputs } from './useAnalysisOutputs.ts'

export function useCountAnalysisData(props: AnalysisPanelDataProps, wallLabel: () => string) {
  const { outputData, outputPlayers, playerOutput } = useAnalysisOutputs(() => props.analysis)
  const hasRedFivePredictions = computed(() => hasRedFiveCountPredictions(
    outputData('wall-tile-count'),
    outputPlayers('opponent-concealed-tile-count'),
  ))
  const countTileRows = computed(() => analysisCountTileRows(hasRedFivePredictions.value))
  const countSourceTiles = computed(() => analysisCountSourceTiles(hasRedFivePredictions.value))
  const opponentSources = computed<TileSource[]>(() => props.shantenOpponents.map((opponent) => ({
    key: opponent.key,
    label: opponent.label,
    seat: opponent.seat,
  })))
  const countSources = computed<TileSource[]>(() => [
    ...opponentSources.value,
    { key: 'wall', label: wallLabel(), seat: null },
  ])
  function tilePrediction(tile: string, source: TileSource): NumericPrediction {
    const property = isRedFiveTile(tile) ? 'redTiles' : 'tiles'
    if (source.seat === null) {
      return parseNumericPrediction(analysisRecord(outputData('wall-tile-count')[property])[tile])
    }
    const player = playerOutput('opponent-concealed-tile-count', source.seat)
    return parseNumericPrediction(analysisRecord(player[property])[tile])
  }
  function countSegments(tile: string, source: TileSource): DistributionEntry[] {
    const prediction = tilePrediction(tile, source)
    const values = (isRedFiveTile(tile) ? [0, 1] : [0, 1, 2, 3, 4]).map((value) => ({
      value,
      probability: prediction.distribution.find((entry) => entry.value === value)?.probability || 0,
    }))
    const total = values.reduce((sum, entry) => sum + entry.probability, 0)
    return total > 0 ? values.map((entry) => ({ ...entry, probability: entry.probability / total })) : values
  }
  function countTooltipContextKey(): string {
    const context = analysisRecord(props.analysis?.context)
    return JSON.stringify([
      context.gameId, context.nodeId, context.seat,
      context.inputMode, context.cacheKey, context.cacheEpoch,
    ])
  }
  function hasCountPrediction(prediction: NumericPrediction): boolean {
    return prediction.scalarValue !== null || prediction.distribution.length > 0
  }
  return {
    countTileRows,
    countSourceTiles,
    countSources,
    tilePrediction,
    countSegments,
    countTooltipContextKey,
    hasCountPrediction,
  }
}
