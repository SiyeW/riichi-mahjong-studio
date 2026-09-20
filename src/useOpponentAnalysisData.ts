import { computed } from 'vue'
import type { AnalysisPanelDataProps } from './analysisPanelTypes.ts'
import { createAnalysisFormatting, type AnalysisTranslator } from './analysisFormatting.ts'
import { adaptiveProbabilityScale, probabilityScaleRatio } from './analysisProbabilityScale.ts'
import type { NumericPrediction } from './numericPrediction.ts'
import { isPossibleRiichiHandValue } from './riichiScoring.ts'
import { useAnalysisOutputs } from './useAnalysisOutputs.ts'
import type { Ref } from 'vue'

export const OPPONENT_DORA_BASE_SCALE = 0.5
export const OPPONENT_SCORE_BASE_SCALE = 0.3

const NON_DEALER_SCORE_GROUP_BOUNDS = [1000, 2000, 3900, 7700, 32000] as const
const DEALER_SCORE_GROUP_BOUNDS = [1500, 2900, 5800, 11600, 48000] as const

export function riichiScoreGroup(value: unknown, dealer: boolean): number | null {
  const score = Number(value)
  if (!Number.isFinite(score)) return null
  const bounds = dealer ? DEALER_SCORE_GROUP_BOUNDS : NON_DEALER_SCORE_GROUP_BOUNDS
  for (let index = 0; index < bounds.length - 1; index += 1) {
    if (score <= bounds[index]) return index
  }
  return score < bounds.at(-1)! ? bounds.length - 1 : bounds.length
}

export function scoreDistributionGroupStarts(
  entries: NumericPrediction['distribution'],
  dealer: boolean,
): boolean[] {
  let previousGroup: number | null = null
  return entries.map((entry, index) => {
    const group = riichiScoreGroup(entry.value, dealer)
    const startsGroup = index > 0 && group !== null && previousGroup !== null && group !== previousGroup
    if (group !== null) previousGroup = group
    return startsGroup
  })
}

export function selectScoreModeNominations(
  entries: NumericPrediction['distribution'],
  count: number,
): NumericPrediction['distribution'] {
  return [...entries]
    .sort((left, right) => right.probability - left.probability)
    .slice(0, Math.max(0, count))
    .sort((left, right) => Number(left.value) - Number(right.value))
}

export function useOpponentAnalysisData(
  props: AnalysisPanelDataProps,
  t: AnalysisTranslator,
  numberLocale: Readonly<Ref<string>>,
) {
  const { seatPrediction } = useAnalysisOutputs(() => props.analysis)
  const formatting = createAnalysisFormatting(t, numberLocale)

  function possibleScorePrediction(prediction: NumericPrediction, dealer: boolean): NumericPrediction {
    const possible = prediction.distribution.filter((entry) => (
      typeof entry.value === 'number' && isPossibleRiichiHandValue(entry.value, dealer)
    ))
    const probabilitySum = possible.reduce((sum, entry) => sum + entry.probability, 0)
    const distribution = probabilitySum > 0 && Math.abs(probabilitySum - 1) > 1e-4
      ? possible.map((entry) => ({ ...entry, probability: entry.probability / probabilitySum }))
      : possible
    if (prediction.scalarSource !== 'distribution') return { ...prediction, distribution }
    return {
      distribution,
      scalarValue: probabilitySum > 0
        ? distribution.reduce((sum, entry) => sum + ((entry.value as number) * entry.probability), 0)
        : null,
      scalarSource: probabilitySum > 0 ? 'distribution' : null,
    }
  }

  const opponentCards = computed(() => props.analysisOpponents.map((opponent) => {
    const dora = seatPrediction('opponent-dora-count', opponent.seat)
    const score = possibleScorePrediction(
      seatPrediction('opponent-score', opponent.seat),
      opponent.seat === props.dealer,
    )
    return {
      ...opponent,
      dora: dora.scalarValue === null ? '—' : dora.scalarValue.toFixed(1),
      score: formatting.formatCompactPoints(score.scalarValue),
      doraPrediction: dora,
      scorePrediction: score,
      scoreModes: [...score.distribution]
        .filter((entry) => entry.probability > 0),
    }
  }))
  const hasOpponentDoraDistributions = computed(() => (
    opponentCards.value.some((opponent) => opponent.doraPrediction.distribution.length)
  ))
  const hasOpponentScoreDistributions = computed(() => (
    opponentCards.value.some((opponent) => opponent.scorePrediction.distribution.length)
  ))
  function distributionProbabilities(predictions: NumericPrediction[]): number[] {
    return predictions.flatMap((prediction) => (
      prediction.distribution.map((entry) => entry.probability)
    ))
  }
  const doraDistributionScale = computed(() => adaptiveProbabilityScale(
    distributionProbabilities(opponentCards.value.map((opponent) => opponent.doraPrediction)),
    OPPONENT_DORA_BASE_SCALE,
  ))
  const scoreDistributionScale = computed(() => adaptiveProbabilityScale(
    distributionProbabilities(opponentCards.value.map((opponent) => opponent.scorePrediction)),
    OPPONENT_SCORE_BASE_SCALE,
  ))
  const doraDistributionReferenceRatio = computed(() => (
    doraDistributionScale.value > OPPONENT_DORA_BASE_SCALE
      ? probabilityScaleRatio(OPPONENT_DORA_BASE_SCALE, doraDistributionScale.value)
      : null
  ))
  const scoreDistributionReferenceRatio = computed(() => (
    scoreDistributionScale.value > OPPONENT_SCORE_BASE_SCALE
      ? probabilityScaleRatio(OPPONENT_SCORE_BASE_SCALE, scoreDistributionScale.value)
      : null
  ))
  function distributionBarScale(value: number, scale: number): number {
    return probabilityScaleRatio(value, scale)
  }
  return {
    ...formatting,
    opponentCards,
    hasOpponentDoraDistributions,
    hasOpponentScoreDistributions,
    doraDistributionScale,
    scoreDistributionScale,
    doraDistributionReferenceRatio,
    scoreDistributionReferenceRatio,
    distributionBarScale,
  }
}
