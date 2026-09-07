import { computed } from 'vue'
import type { AnalysisPanelDataProps } from './analysisPanelTypes.ts'
import { createAnalysisFormatting, type AnalysisTranslator } from './analysisFormatting.ts'
import { clampProbability } from './analysisProbabilityScale.ts'
import type { NumericPrediction } from './numericPrediction.ts'
import { useAnalysisOutputs } from './useAnalysisOutputs.ts'
import type { Ref } from 'vue'

export function useOpponentAnalysisData(
  props: AnalysisPanelDataProps,
  t: AnalysisTranslator,
  numberLocale: Readonly<Ref<string>>,
) {
  const { seatPrediction } = useAnalysisOutputs(() => props.analysis)
  const formatting = createAnalysisFormatting(t, numberLocale)
  const opponentCards = computed(() => props.shantenOpponents.map((opponent) => {
    const dora = seatPrediction('opponent-dora-count', opponent.seat)
    const score = seatPrediction('opponent-score', opponent.seat)
    return {
      ...opponent,
      dora: dora.scalarValue === null ? '—' : dora.scalarValue.toFixed(1),
      score: formatting.formatCompactPoints(score.scalarValue),
      doraPrediction: dora,
      scorePrediction: score,
      scoreModes: [...score.distribution]
        .sort((left, right) => right.probability - left.probability)
        .slice(0, 3),
    }
  }))
  const hasOpponentDoraDistributions = computed(() => (
    opponentCards.value.some((opponent) => opponent.doraPrediction.distribution.length)
  ))
  const hasOpponentScoreDistributions = computed(() => (
    opponentCards.value.some((opponent) => opponent.scorePrediction.distribution.length)
  ))
  function maximumDistributionProbability(predictions: NumericPrediction[]): number {
    return Math.max(0.01, ...predictions.flatMap((prediction) => (
      prediction.distribution.map((entry) => entry.probability)
    )))
  }
  const doraDistributionScale = computed(() => maximumDistributionProbability(
    opponentCards.value.map((opponent) => opponent.doraPrediction),
  ))
  const scoreDistributionScale = computed(() => maximumDistributionProbability(
    opponentCards.value.map((opponent) => opponent.scorePrediction),
  ))
  function distributionBarHeight(value: number, scale: number): string {
    return `${Math.min(1, clampProbability(value) / Math.max(0.01, scale)) * 100}%`
  }
  return {
    ...formatting,
    opponentCards,
    hasOpponentDoraDistributions,
    hasOpponentScoreDistributions,
    doraDistributionScale,
    scoreDistributionScale,
    distributionBarHeight,
  }
}
