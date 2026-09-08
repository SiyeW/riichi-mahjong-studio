import { computed, type Ref } from 'vue'

type Translate = (key: string, params?: Record<string, string | number>) => string

export interface DecisionAnalysisEntry {
  candidateId?: string
  type?: string
  variant?: string
  pai?: string
  consumed?: string[]
  tsumogiri?: boolean
  isBest?: boolean
  bar?: number
  probability?: number
  value?: number
}

export interface DecisionDiscardSlot {
  entry: DecisionAnalysisEntry | null
}

export function useDecisionEntryPresentation(options: {
  gameView: TrainerGameView
  t: Translate
  normalizeTileFamily: (tile: string) => string
  redFive: (tile: string) => string
  reactionTypeLabel: (type: string) => string
}) {
  const {
    gameView,
    t,
    normalizeTileFamily,
    redFive,
    reactionTypeLabel,
  } = options

  function formatDelta(delta: number): string {
    return delta > 0 ? `+${delta}` : `${delta}`
  }

  function resolveSpecialEntry(action: TrainerAction) {
    if (!gameView.analysis?.specialEntries?.length) return null
    const candidateId = action.candidateId || action.id
    const exactCandidate = gameView.analysis.specialEntries.find((entry) => (
      entry.candidateId === candidateId
    ))
    if (exactCandidate) return exactCandidate
    const actionVariant = action.variant || ''
    return gameView.analysis.specialEntries.find((entry) => {
      if (entry.type !== action.type) return false
      if (entry.variant === actionVariant) return true
      return actionVariant.startsWith(entry.variant + ':')
    }) || null
  }

  function resolveReactionEntry(action: TrainerAction) {
    const entries = gameView.analysis?.reactionEntries || []
    if (!entries.length) return null
    const candidateId = action.candidateId || action.id
    const exactCandidate = entries.find((entry) => entry.candidateId === candidateId)
    if (exactCandidate) return exactCandidate
    const actionVariant = action.variant || action.type
    const exact = entries.find((entry) => (
      entry.type === action.type && entry.variant === actionVariant
    ))
    if (exact) return exact

    const sameType = entries.filter((entry) => entry.type === action.type)
    return sameType.length === 1 ? sameType[0] : null
  }

  function resolveDiscardEntry(action: TrainerAction) {
    const entries = gameView.analysis?.discardEntries || []
    const candidateId = action.candidateId || action.id
    const exactCandidate = entries.find((entry) => entry.candidateId === candidateId)
    if (exactCandidate) return exactCandidate
    const exactPhysical = entries.find((entry) => (
      entry.pai === action.pai
      && Boolean(entry.tsumogiri) === Boolean(action.tsumogiri)
    ))
    if (exactPhysical) return exactPhysical
    const sameTile = entries.filter((entry) => entry.pai === action.pai)
    return sameTile.length === 1 ? sameTile[0] : null
  }

  function analysisEntryIsBest(entry?: {
    candidateId?: string
    type?: string
    variant?: string
    pai?: string
    consumed?: string[]
    tsumogiri?: boolean
    isBest?: boolean
  } | null): boolean {
    if (!entry) return false
    if (typeof entry.isBest === 'boolean') return entry.isBest
    const best = gameView.analysis?.bestAction as Record<string, unknown> | null | undefined
    if (!best) return false
    if (entry.type) {
      return best.type === entry.type
        && best.variant === entry.variant
        && [...((best.consumed as string[] | undefined) || [])].sort().join(',')
          === [...(entry.consumed || [])].sort().join(',')
    }
    return best.type === 'dahai'
      && best.pai === entry.pai
      && (
        typeof best.tsumogiri !== 'boolean'
        || Boolean(best.tsumogiri) === Boolean(entry.tsumogiri)
      )
  }

  function rawAnalysisEntryBar(entry?: { bar?: number; probability?: number } | null): number {
    return Math.max(0, Number(entry?.bar ?? entry?.probability) || 0)
  }

  function resolveReactionAnalysisLabel(entry: { type?: string; variant?: string; label?: string; pai?: string; consumed?: string[] }): string {
    const actionType = entry.type || ''
    if (actionType === 'chi') return t('action.chi')
    if (actionType === 'pon') return t('action.pon')
    if (actionType === 'daiminkan') return t('action.kan')
    if (actionType === 'hora') return t('action.ron')
    if (actionType === 'none') return t('action.skip')
    return reactionTypeLabel(actionType)
  }

  function resolveSpecialAnalysisLabel(entry: { type?: string; variant?: string; label?: string; pai?: string; consumed?: string[] }): string {
    const actionType = entry.type || ''
    if (actionType === 'reach') return t('action.riichi')
    if (actionType === 'hora') return entry.variant === 'tsumo' ? t('action.tsumo') : t('action.ron')
    if (actionType === 'ankan' || actionType === 'kakan' || actionType === 'daiminkan') return t('action.kan')
    if (actionType === 'ryukyoku') return t('draw.kyuushu')
    if (actionType === 'none') return t('action.skip')
    return entry.label || actionType
  }

  function analysisActionDisplayTiles(entry: { type?: string; pai?: string; consumed?: string[] }): string[] {
    const type = entry.type || ''
    const consumed = [...(entry.consumed || [])].filter(Boolean)
    if (type === 'chi') return consumed
    if (type === 'pon') {
      const tile = entry.pai || consumed[0]
      return tile ? [tile] : []
    }
    if (type === 'ankan') {
      const tile = consumed.find((candidate) => candidate.endsWith('r')) || entry.pai || consumed[0]
      if (!tile) return []
      const family = normalizeTileFamily(tile)
      return family === '5m' || family === '5p' || family === '5s'
        ? [redFive(family)]
        : [tile]
    }
    if (type === 'daiminkan' || type === 'kakan') {
      const tile = entry.pai || consumed[0]
      return tile ? [tile] : []
    }
    return []
  }

  const decisionMetricDefinitions = computed<TrainerDecisionMetricDefinition[]>(() => (
    gameView.analysis?.metricDefinitions || []
  ))

  const mergedAnalysisEntries = computed(() => {
    const discardEntries = gameView.analysis?.discardEntries || []
    const specialEntries = gameView.analysis?.specialEntries || []
    const all = [
      ...discardEntries.map((e) => ({
        ...e,
        _kind: 'discard' as const,
        _key: `d:${e.candidateId || `${e.pai}:${Boolean(e.tsumogiri)}`}`,
      })),
      ...specialEntries.map((e) => ({
        ...e,
        _kind: 'special' as const,
        _key: `s:${e.candidateId || e.variant || e.type}`,
      })),
    ]
    const primaryMetric = decisionMetricDefinitions.value.find((metric) => (
      metric.id === gameView.analysis?.primaryMetricId
    ))
    if (primaryMetric?.preferredDirection === 'lower') {
      all.sort((a, b) => (a.value ?? 0) - (b.value ?? 0))
    } else if (primaryMetric?.preferredDirection === 'higher' || !primaryMetric) {
      all.sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    }
    return all
  })

  function discardVariantLabel(entry: { pai: string; tsumogiri?: boolean }): string {
    const variants = (gameView.analysis?.discardEntries || []).filter((candidate) => (
      candidate.pai === entry.pai
    ))
    if (!variants.some((candidate) => Boolean(candidate.tsumogiri))
      || !variants.some((candidate) => !candidate.tsumogiri)) {
      return ''
    }
    return entry.tsumogiri
      ? t('evaluation.actionSuffix', { action: t('action.tsumogiri') })
      : t('evaluation.actionSuffix', { action: t('action.tedashi') })
  }

  function formatDecisionMetric(
    value: number | null | undefined,
    metric: TrainerDecisionMetricDefinition,
  ): string {
    if (value == null || !Number.isFinite(value)) return '—'
    const displayedValue = metric.format === 'percentage' ? value * 100 : value
    const fractionDigits = Number.isInteger(metric.fractionDigits)
      && Number(metric.fractionDigits) >= 0
      && Number(metric.fractionDigits) <= 12
      ? Number(metric.fractionDigits)
      : null
    const text = fractionDigits === null
      ? new Intl.NumberFormat('en-US', {
          useGrouping: metric.format === 'points',
          maximumSignificantDigits: 15,
        }).format(displayedValue)
      : new Intl.NumberFormat('en-US', {
          useGrouping: metric.format === 'points',
          minimumFractionDigits: fractionDigits,
          maximumFractionDigits: fractionDigits,
        }).format(displayedValue)
    return metric.format === 'percentage' ? `${text}%` : text
  }

  const recommendationBarMax = computed(() => {
    const entries = [
      ...(gameView.analysis?.discardEntries || []),
      ...(gameView.analysis?.specialEntries || []),
      ...(gameView.analysis?.reactionEntries || []),
    ]
    return entries.reduce((best, entry) => Math.max(best, rawAnalysisEntryBar(entry)), 0)
  })

  function normalizeRecommendationBar(raw: number): number {
    if (recommendationBarMax.value <= 0) return 0
    return Math.max(0, Math.min(1, raw / recommendationBarMax.value))
  }

  function resolveAnalysisEntryBar(entry: { bar?: number; probability?: number }): number {
    return normalizeRecommendationBar(rawAnalysisEntryBar(entry))
  }

  return {
    formatDelta,
    resolveSpecialEntry,
    resolveReactionEntry,
    resolveDiscardEntry,
    analysisEntryIsBest,
    resolveReactionAnalysisLabel,
    resolveSpecialAnalysisLabel,
    analysisActionDisplayTiles,
    decisionMetricDefinitions,
    mergedAnalysisEntries,
    discardVariantLabel,
    formatDecisionMetric,
    resolveAnalysisEntryBar,
  }
}

export function useDecisionActionPresentation(options: {
  gameView: TrainerGameView
  showTrainingRecommendations: Readonly<Ref<boolean>>
  t: Translate
  normalizeTileFamily: (tile: string) => string
  redFive: (tile: string) => string
  getSpecialActions: () => TrainerAction[]
  getDiscardActions: () => TrainerAction[]
  getSouthHandDisplay: () => string[]
  hasRecommendationAnalysis: () => boolean
  resolveSpecialEntry: ReturnType<typeof useDecisionEntryPresentation>['resolveSpecialEntry']
  resolveReactionEntry: ReturnType<typeof useDecisionEntryPresentation>['resolveReactionEntry']
  resolveDiscardEntry: ReturnType<typeof useDecisionEntryPresentation>['resolveDiscardEntry']
  analysisEntryIsBest: ReturnType<typeof useDecisionEntryPresentation>['analysisEntryIsBest']
  resolveAnalysisEntryBar: ReturnType<typeof useDecisionEntryPresentation>['resolveAnalysisEntryBar']
}) {
  const {
    gameView,
    showTrainingRecommendations,
    t,
    normalizeTileFamily,
    redFive,
    getSpecialActions,
    getDiscardActions,
    getSouthHandDisplay,
    hasRecommendationAnalysis,
    resolveSpecialEntry,
    resolveReactionEntry,
    resolveDiscardEntry,
    analysisEntryIsBest,
    resolveAnalysisEntryBar,
  } = options

  function actionDisplayTiles(action: TrainerAction): string[] {
    const consumed = [...(action.consumed || [])]
    if (action.type === 'ankan') {
      const tile = consumed.find((candidate) => candidate.endsWith('r'))
        || action.pai
        || consumed[0]
        || ''
      const family = normalizeTileFamily(tile)
      return family === '5m' || family === '5p' || family === '5s'
        ? [redFive(family)]
        : [tile]
    }
    if (action.type === 'daiminkan' || action.type === 'kakan') {
      return action.pai ? [action.pai] : consumed.slice(0, 1)
    }
    if (action.type === 'chi' || action.type === 'pon') return consumed
    if (action.pai) consumed.push(action.pai)
    return consumed
  }

  function resolveActionBar(action: TrainerAction): number {
    if (action.type === 'dahai') return resolveAnalysisEntryBar(resolveDiscardEntry(action) || {})
    return resolveAnalysisEntryBar(resolveReactionEntry(action) || resolveSpecialEntry(action) || {})
  }

  function findQuickPassAction(): TrainerAction | null {
    return getSpecialActions().find((action) => action.type === 'none') || null
  }

  function findQuickTsumogiriAction(): TrainerAction | null {
    const hand = getSouthHandDisplay()
    if (!hand.length) return null
    const lastTile = hand[hand.length - 1]
    return getDiscardActions().find((action) => action.pai === lastTile) || null
  }

  function formatActionValue(action: TrainerAction): string {
    if (action.type !== 'dahai') {
      const special = resolveSpecialEntry(action)
      if (special) return special.value.toFixed(3)
      if (action.type === 'hora') return t('action.win')
      if (action.type === 'reach') return t('action.riichi')
      if (action.type === 'ryukyoku') return t('action.drawResult')
    }
    if (action.value !== undefined) return action.value.toFixed(3)
    if (!action.pai || !gameView.analysis?.discardEntries?.length) return '-'
    const entry = resolveDiscardEntry(action)
    return entry ? entry.value.toFixed(3) : '-'
  }

  function resolveDisplayedActionBar(action: TrainerAction): number {
    if (!showTrainingRecommendations.value || !hasRecommendationAnalysis()) return 0
    return resolveActionBar(action)
  }

  function resolveDisplayedDiscardSlotBar(slot: DecisionDiscardSlot): number {
    if (!showTrainingRecommendations.value || !hasRecommendationAnalysis() || !slot.entry) return 0
    return resolveAnalysisEntryBar(slot.entry)
  }

  function clampBarScale(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.min(1, value))
  }

  function barFillStyle(value: number) {
    return { transform: `scaleY(${clampBarScale(value)})` }
  }

  function barUpperStyle(value: number) {
    return { transform: `scaleY(${1 - clampBarScale(value)})` }
  }

  function isBestAction(action?: TrainerAction): boolean {
    if (!action) return false
    if (action.type === 'dahai') return analysisEntryIsBest(resolveDiscardEntry(action))
    return analysisEntryIsBest(resolveReactionEntry(action) || resolveSpecialEntry(action))
  }

  return {
    actionDisplayTiles,
    barFillStyle,
    barUpperStyle,
    findQuickPassAction,
    findQuickTsumogiriAction,
    formatActionValue,
    isBestAction,
    resolveDisplayedActionBar,
    resolveDisplayedDiscardSlotBar,
  }
}
