import { computed, type Ref } from 'vue'
import { symmetricDeltaScale } from './analysisDeltaScale.ts'
import type { CountSourceKey } from './analysisCountPalette.ts'
import { adaptiveProbabilityScale, clampProbability as probability, DEFAULT_PROBABILITY_SCALE, probabilityScaleRatio, probabilityScaleTicks } from './analysisProbabilityScale.ts'
import { hasRedFiveCountPredictions } from './analysisTileCounts.ts'
import { ANALYSIS_TILE_ROWS as tileRows, analysisCountSourceTiles, analysisCountTileRows, isRedFiveTile } from './analysisTiles.ts'
import { resolveKyokuOutcome } from './kyokuOutcome.ts'
import { parseNumericPrediction as parsePrediction, type DistributionEntry, type DistributionValue, type NumericPrediction } from './numericPrediction.ts'
import { analysisRecord as objectValue, useAnalysisOutputs, type AnalysisRecord } from './useAnalysisOutputs.ts'

export type TileSource = { key: CountSourceKey; label: string; seat: number | null }
export interface AnalysisPanelDataProps {
  analysis: AnalysisRecord | null | undefined
  shantenOpponents: Array<{ key: Exclude<CountSourceKey, 'wall'>; seat: number; label: string; probabilities: number[] }>
  controlledSeat: number
  dealer: number
}

type Formatting = {
  t: (key: string, params?: Record<string, string | number>) => string
  numberLocale: Readonly<Ref<string>>
}

export function useAnalysisPanelData(props: AnalysisPanelDataProps, { t, numberLocale }: Formatting) {
  const { outputData, outputPlayers, playerOutput, seatPrediction } = useAnalysisOutputs(() => props.analysis)

  const hasRedFivePredictions = computed(() => {
    return hasRedFiveCountPredictions(
      outputData('wall-tile-count'),
      outputPlayers('opponent-concealed-tile-count'),
    )
  })

  const countTileRows = computed(() => analysisCountTileRows(hasRedFivePredictions.value))
  const countSourceTiles = computed(() => analysisCountSourceTiles(hasRedFivePredictions.value))

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
    if (typeof value !== 'number') return String(value)
    return formatCompactPoints(value)
  }

  function formatProbability(value: number): string {
    const percentage = probability(value) * 100
    if (percentage === 0) return '0%'
    if (percentage < 0.01) return '<0.01%'
    return `${percentage.toFixed(1)}%`
  }

  const opponentCards = computed(() => props.shantenOpponents.map((opponent) => {
    const dora = seatPrediction('opponent-dora-count', opponent.seat)
    const score = seatPrediction('opponent-score', opponent.seat)
    return {
      ...opponent,
      dora: dora.scalarValue === null ? '—' : dora.scalarValue.toFixed(1),
      score: formatCompactPoints(score.scalarValue),
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
    return Math.max(
      0.01,
      ...predictions.flatMap((prediction) => prediction.distribution.map((entry) => entry.probability)),
    )
  }

  const doraDistributionScale = computed(() => maximumDistributionProbability(
    opponentCards.value.map((opponent) => opponent.doraPrediction),
  ))
  const scoreDistributionScale = computed(() => maximumDistributionProbability(
    opponentCards.value.map((opponent) => opponent.scorePrediction),
  ))

  function distributionBarHeight(value: number, scale: number): string {
    return `${Math.min(1, probability(value) / Math.max(0.01, scale)) * 100}%`
  }

  function relativeLabel(seat: number): string {
    const offset = (seat - props.controlledSeat + 4) % 4
    return [t('seat.self'), t('seat.shimocha'), t('seat.toimen'), t('seat.kamicha')][offset]
      || t('seat.number', { seat })
  }

  function windLabel(seat: number): string {
    const wind = [t('wind.east'), t('wind.south'), t('wind.west'), t('wind.north')][(seat - props.dealer + 4) % 4] || '?'
    return t('seat.windRelative', { wind, relative: relativeLabel(seat) })
  }

  function targetRows(player: AnalysisRecord, winnerSeat: number) {
    const raw = Array.isArray(player.targetGivenWin) ? player.targetGivenWin.map(objectValue) : []
    if (!raw.length) return []
    return [winnerSeat, (winnerSeat + 1) % 4, (winnerSeat + 2) % 4, (winnerSeat + 3) % 4].map((seat) => {
      const entry = raw.find((item) => Number(item.seat) === seat)
      return {
        seat,
        label: seat === winnerSeat ? t('action.tsumo') : windLabel(seat),
        probability: probability(entry?.probability),
      }
    })
  }

  const kyokuOutcome = computed(() => resolveKyokuOutcome(outputData('kyoku-outcome')))
  const legacyKyokuPlayers = computed(() => outputPlayers('kyoku-outcome'))
  const outcomeSegments = computed(() => {
    const self = kyokuOutcome.value.players.find((player) => player.seat === props.controlledSeat)
    const draw = kyokuOutcome.value.drawProbability
    const selfWin = self?.winProbability || 0
    const selfDealIn = self?.dealInProbability || 0
    const horizontal = kyokuOutcome.value.hasTotals
      ? Math.max(0, 1 - draw - selfWin - selfDealIn)
      : 0
    const segments = [
      { key: 'draw', label: t('analysis.draw'), probability: draw },
      { key: 'self-win', label: t('analysis.selfWin'), probability: selfWin },
      { key: 'self-deal-in', label: t('analysis.selfDealIn'), probability: selfDealIn },
      { key: 'horizontal', label: t('analysis.horizontal'), probability: horizontal },
    ]
    const total = segments.reduce((sum, segment) => sum + segment.probability, 0) || 1
    return segments.map((segment) => ({ ...segment, displayProbability: segment.probability / total }))
  })

  const playerSeatOrder = computed(() => [
    (props.controlledSeat + 3) % 4,
    props.controlledSeat,
    (props.controlledSeat + 1) % 4,
    (props.controlledSeat + 2) % 4,
  ])

  const playerRows = computed(() => playerSeatOrder.value.map((seat) => {
    const outcome = kyokuOutcome.value.players.find((player) => player.seat === seat)!
    const legacyOutcome = legacyKyokuPlayers.value.find((player) => Number(player.seat) === seat) || {}
    const delta = seatPrediction('kyoku-score-delta', seat)
    const placement = seatPrediction('match-placement', seat)
    const matchScore = seatPrediction('match-score', seat)
    const normalizedPlacement = [4, 3, 2, 1].map((value) => ({
      value,
      probability: placement.distribution.find((entry) => entry.value === value)?.probability || 0,
    }))
    return {
      seat,
      label: windLabel(seat),
      winProbability: outcome.winProbability,
      dealInProbability: outcome.dealInProbability,
      targets: outcome.winTargets.length ? outcome.winTargets.map((target) => ({
        ...target,
        label: target.seat === seat ? t('action.tsumo') : windLabel(target.seat),
      })) : targetRows(legacyOutcome, seat),
      dealInWinnerSets: outcome.dealInWinnerSets,
      kyokuDelta: delta.scalarValue,
      placement: normalizedPlacement,
      expectedPlacement: placement.scalarValue === null ? '—' : placement.scalarValue.toFixed(2),
      matchScore: matchScore.scalarValue,
    }
  }))

  const maxAbsoluteDelta = computed(() => (
    symmetricDeltaScale(playerRows.value.map((player) => player.kyokuDelta))
  ))

  const opponentSources = computed<TileSource[]>(() => props.shantenOpponents.map((opponent) => ({
    key: opponent.key,
    label: opponent.label,
    seat: opponent.seat,
  })))
  const countSources = computed<TileSource[]>(() => [
    ...opponentSources.value,
    { key: 'wall', label: t('analysis.wall'), seat: null },
  ])

  function riskProbability(seat: number | null, tile: string): number {
    if (seat === null) return 0
    const player = playerOutput('opponent-deal-in-probability', seat)
    return probability(objectValue(player.tiles)[tile])
  }

  const RISK_ADAPTIVE_MIN = DEFAULT_PROBABILITY_SCALE
  const riskScale = computed(() => adaptiveProbabilityScale(
    opponentSources.value.flatMap((source) => tileRows.flatMap((row) => (
      row.map((tile) => riskProbability(source.seat, tile))
    ))),
  ))

  const showRiskAdaptiveThreshold = computed(() => riskScale.value > RISK_ADAPTIVE_MIN)
  const riskScaleTicks = computed(() => probabilityScaleTicks(riskScale.value))

  function riskBarScale(value: number): number {
    return probabilityScaleRatio(value, riskScale.value)
  }

  function riskScalePosition(value: number): string {
    return `${riskBarScale(value) * 100}%`
  }

  function tilePrediction(tile: string, source: TileSource): NumericPrediction {
    const property = isRedFiveTile(tile) ? 'redTiles' : 'tiles'
    if (source.seat === null) {
      return parsePrediction(objectValue(outputData('wall-tile-count')[property])[tile])
    }
    const player = playerOutput('opponent-concealed-tile-count', source.seat)
    return parsePrediction(objectValue(player[property])[tile])
  }

  function countSegments(tile: string, source: TileSource): DistributionEntry[] {
    const prediction = tilePrediction(tile, source)
    const values = (isRedFiveTile(tile) ? [0, 1] : [0, 1, 2, 3, 4]).map((value) => ({
      value,
      probability: prediction.distribution.find((entry) => entry.value === value)?.probability || 0,
    }))
    const total = values.reduce((sum, entry) => sum + entry.probability, 0)
    if (total > 0) return values.map((entry) => ({ ...entry, probability: entry.probability / total }))
    return values
  }

  function countTooltipContextKey(): string {
    const context = objectValue(props.analysis?.context)
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
    opponentCards,
    hasOpponentDoraDistributions,
    hasOpponentScoreDistributions,
    doraDistributionScale,
    scoreDistributionScale,
    distributionBarHeight,
    outcomeSegments,
    playerRows,
    maxAbsoluteDelta,
    opponentSources,
    countSources,
    riskProbability,
    riskScale,
    showRiskAdaptiveThreshold,
    riskScaleTicks,
    riskBarScale,
    riskScalePosition,
    tilePrediction,
    countSegments,
    countTooltipContextKey,
    hasCountPrediction,
    formatCompactPoints,
    formatPoints,
    formatPlainPoints,
    formatSignedCompactPoints,
    formatDistributionPoints,
    formatProbability,
    windLabel,
  }
}
