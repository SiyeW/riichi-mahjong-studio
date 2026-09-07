import { computed, type Ref } from 'vue'
import type { AnalysisPanelDataProps } from './analysisPanelTypes.ts'
import { symmetricDeltaScale } from './analysisDeltaScale.ts'
import { createAnalysisFormatting, type AnalysisTranslator } from './analysisFormatting.ts'
import { clampProbability } from './analysisProbabilityScale.ts'
import { resolveKyokuOutcome } from './kyokuOutcome.ts'
import { analysisRecord, useAnalysisOutputs, type AnalysisRecord } from './useAnalysisOutputs.ts'

export function useGameAnalysisData(
  props: AnalysisPanelDataProps,
  t: AnalysisTranslator,
  numberLocale: Readonly<Ref<string>>,
) {
  const { outputData, outputPlayers, seatPrediction } = useAnalysisOutputs(() => props.analysis)
  const formatting = createAnalysisFormatting(t, numberLocale)
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
    const raw = Array.isArray(player.targetGivenWin) ? player.targetGivenWin.map(analysisRecord) : []
    if (!raw.length) return []
    return [winnerSeat, (winnerSeat + 1) % 4, (winnerSeat + 2) % 4, (winnerSeat + 3) % 4].map((seat) => {
      const entry = raw.find((item) => Number(item.seat) === seat)
      return {
        seat,
        label: seat === winnerSeat ? t('action.tsumo') : windLabel(seat),
        probability: clampProbability(entry?.probability),
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
    const horizontal = kyokuOutcome.value.hasTotals ? Math.max(0, 1 - draw - selfWin - selfDealIn) : 0
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
      placement: [4, 3, 2, 1].map((value) => ({
        value,
        probability: placement.distribution.find((entry) => entry.value === value)?.probability || 0,
      })),
      expectedPlacement: placement.scalarValue === null ? '—' : placement.scalarValue.toFixed(2),
      matchScore: matchScore.scalarValue,
    }
  }))
  const maxAbsoluteDelta = computed(() => symmetricDeltaScale(
    playerRows.value.map((player) => player.kyokuDelta),
  ))
  return { ...formatting, outcomeSegments, playerRows, maxAbsoluteDelta, windLabel }
}
