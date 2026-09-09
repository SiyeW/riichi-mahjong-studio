import { computed, nextTick, ref, watch, type Ref } from 'vue'
import { acceptsAnalysisEpoch } from './analysisEpoch.ts'
import { decisionPositionKey } from './analysisPosition.ts'
import type { TranslationParams } from './i18n'
import type { StudioSettings } from './contracts/settings'

type Translate = (key: string, params?: TranslationParams) => string
type DecisionAnalysis = NonNullable<TrainerGameView['analysis']>

interface UseAnalysisSessionOptions {
  settings: StudioSettings
  status: TrainerStatusSnapshot
  gameView: TrainerGameView
  showAnalysisDock: Readonly<Ref<boolean>>
  t: Translate
  normalizeTrainingMode: (mode: string) => StudioSettings['training']['mode']
  applyStatus: (status: TrainerStatusSnapshot) => void
  applyGameView: (view: TrainerGameView) => void
  scheduleTableZoomRecalc: () => void
  clearDecisionPresentation: (treeRevision: number) => void
}

export const SHANTEN_SHORT_LABELS = ['0', '1', '2', '3', '4', '5', '6', 'X']

function hasShantenRows(group: Record<string, number[]> | undefined): group is Record<string, number[]> {
  return Boolean(group && Object.values(group).some((values) => Array.isArray(values) && values.length > 0))
}

export function shantenResultHasRows(result: Record<string, unknown> | null | undefined): boolean {
  if (!result) return false
  const predictions = result.predictions as Record<string, unknown> | undefined
  const groundTruth = result.ground_truth as Record<string, unknown> | undefined
  const outputs = result.outputs as Record<string, unknown> | undefined
  return Boolean(outputs && Object.keys(outputs).length) || [predictions, groundTruth].some((section) => (
    hasShantenRows(section?.opponents as Record<string, number[]> | undefined)
    || hasShantenRows(section?.ron_wait as Record<string, number[]> | undefined)
  ))
}

export function useAnalysisSession(options: UseAnalysisSessionOptions) {
  const {
    settings,
    status,
    gameView,
    showAnalysisDock,
    t,
    normalizeTrainingMode,
    applyStatus,
    applyGameView,
    scheduleTableZoomRecalc,
    clearDecisionPresentation,
  } = options

  const decisionRecommendationsEnabled = ref(true)
  const decisionAnalysisEventCache = new Map<string, DecisionAnalysis>()
  const ronWaitPredData = ref<Record<string, number[]>>({})
  const ronWaitGTData = ref<Record<string, number[]>>({})
  const shantenPredData = ref<Record<string, number[]>>({})
  const shantenGTData = ref<Record<string, number[]>>({})
  const shantenViewMode = ref<'predictions' | 'ground_truth'>('predictions')
  const suppressOpponentAnalysisTransitions = ref(false)
  const shantenRawData = ref<Record<string, Record<string, unknown>>>({})
  const shantenRawJson = computed(() => JSON.stringify(shantenRawData.value, null, 2))
  const shantenStatus = ref('—')
  const clearingAnalysisCaches = ref(false)
  const analysisCacheClearMessage = ref('')
  let opponentAnalysisResetGeneration = 0
  let minimumDecisionCacheEpoch: number | null = null
  let minimumOpponentCacheEpoch: number | null = null
  let deferredShantenResult: Record<string, unknown> | null = null
  let shantenReadGeneration = 0
  let analysisVisibilityGeneration = 0

  const shantenData = computed(() => (
    shantenViewMode.value === 'ground_truth' ? shantenGTData.value : shantenPredData.value
  ))
  const SHANTEN_LABELS = computed(() => [
    t('shanten.tenpai'),
    t('shanten.one'),
    t('shanten.two'),
    t('shanten.three'),
    t('shanten.four'),
    t('shanten.five'),
    t('shanten.six'),
    t('shanten.furiten'),
  ])
  const hasOpponentGroundTruth = computed(() => (
    hasShantenRows(shantenGTData.value) || hasShantenRows(ronWaitGTData.value)
  ))
  const effectiveDecisionRecommendationsEnabled = computed(() => (
    status.mode === 'play' || decisionRecommendationsEnabled.value
  ))
  const showTrainingRecommendations = computed(() => {
    if (!effectiveDecisionRecommendationsEnabled.value) return false
    if (status.mode === 'research') return true
    if (gameView.pendingReview) return true
    return normalizeTrainingMode(settings.training.mode) === 'preview_before_click'
  })
  const opponentAnalysisNeeded = computed(() => (
    showTrainingRecommendations.value || showAnalysisDock.value
  ))
  const hasOpponentAnalysisResult = computed(() => (
    shantenResultHasRows(gameView.opponentAnalysis)
    || hasShantenRows(shantenPredData.value)
    || hasShantenRows(ronWaitPredData.value)
    || hasShantenRows(shantenGTData.value)
    || hasShantenRows(ronWaitGTData.value)
  ))
  const opponentAnalysisLoadError = computed(() => {
    const modelError = status.modelActivity?.errors?.opponentAnalysis
    if (modelError) return String(modelError)
    return shantenStatus.value.startsWith('err:') ? shantenStatus.value.slice(4).trim() : ''
  })
  const opponentAnalysisPermanentlyUnavailable = computed(() => {
    const activity = status.modelActivity?.opponentAnalysis
    return status.modelRuntime.opponentAnalysis.unloaded
      || activity === 'error'
  })
  const opponentAnalysisIsLoading = computed(() => {
    const rawActivity: unknown = status.modelActivity?.opponentAnalysis
    const activity = rawActivity === 'loading' || rawActivity === 'running' || rawActivity === 'error'
      ? rawActivity
      : rawActivity === true ? 'running' : 'idle'
    if (status.modelRuntime.opponentAnalysis.unloaded) return false
    if (activity === 'loading') return true
    if (activity === 'error' || opponentAnalysisLoadError.value) return false
    return !hasOpponentAnalysisResult.value
      && (activity === 'running' || gameView.opponentAnalysis?.status === 'loading')
  })
  const shantenOpponents = computed(() => {
    const controlledSeat = status.controlledSeat
    const opponents = [
      { key: 'kamicha', seat: (controlledSeat + 3) % 4, label: t('seat.kamicha') },
      { key: 'toimen', seat: (controlledSeat + 2) % 4, label: t('seat.toimen') },
      { key: 'shimocha', seat: (controlledSeat + 1) % 4, label: t('seat.shimocha') },
    ] as const
    return opponents.map((opponent) => ({
      ...opponent,
      probabilities: shantenData.value[opponent.key] || [],
    }))
  })
  const canToggleDecisionRecommendations = computed(() => status.mode === 'research')

  function shantenResultMatchesCurrentPosition(result: Record<string, unknown>): boolean {
    const context = result.context as Record<string, unknown> | undefined
    if (!context || !acceptsAnalysisEpoch(context.cacheEpoch, minimumOpponentCacheEpoch)) return false
    return context.gameId === gameView.gameId
      && context.nodeId === gameView.currentNodeId
      && Number(context.seat) === status.controlledSeat
  }

  function suppressOpponentAnalysisMotion() {
    const resetGeneration = ++opponentAnalysisResetGeneration
    suppressOpponentAnalysisTransitions.value = true
    deferredShantenResult = null
    void nextTick(() => {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (resetGeneration !== opponentAnalysisResetGeneration) return
          suppressOpponentAnalysisTransitions.value = false
          const deferredResult = deferredShantenResult
          deferredShantenResult = null
          if (deferredResult) applyShantenResult(deferredResult)
        })
      })
    })
  }

  function clearOpponentAnalysisWithoutMotion() {
    suppressOpponentAnalysisMotion()
    shantenPredData.value = {}
    shantenGTData.value = {}
    ronWaitPredData.value = {}
    ronWaitGTData.value = {}
    shantenRawData.value = {}
    shantenStatus.value = '—'
  }

  function applyShantenResult(
    result: Record<string, unknown>,
    applyOptions: { withoutMotion?: boolean; clearWhenEmpty?: boolean } = {},
  ): boolean {
    if (!shantenResultMatchesCurrentPosition(result)) return false
    gameView.opponentAnalysis = result
    if (suppressOpponentAnalysisTransitions.value && !applyOptions.withoutMotion) {
      deferredShantenResult = result
      return true
    }

    const raw = result.raw as Record<string, unknown> | undefined
    shantenStatus.value = String(result.status || '?')
    shantenRawData.value = raw ? raw as Record<string, Record<string, unknown>> : {}
    const predictions = result.predictions as Record<string, unknown> | undefined
    const groundTruth = result.ground_truth as Record<string, unknown> | undefined
    const predOpponents = predictions?.opponents as Record<string, number[]> | undefined
    const predRonWait = predictions?.ron_wait as Record<string, number[]> | undefined
    const gtOpponents = groundTruth?.opponents as Record<string, number[]> | undefined
    const gtRonWait = groundTruth?.ron_wait as Record<string, number[]> | undefined
    const hasPredOpponents = hasShantenRows(predOpponents)
    const hasPredRonWait = hasShantenRows(predRonWait)
    const hasGtOpponents = hasShantenRows(gtOpponents)
    const hasGtRonWait = hasShantenRows(gtRonWait)
    const protocolOutputs = result.outputs as Record<string, unknown> | undefined
    const hasResult = hasPredOpponents || hasPredRonWait || hasGtOpponents || hasGtRonWait
      || Boolean(protocolOutputs && Object.keys(protocolOutputs).length)
    if (!hasResult) {
      if (applyOptions.clearWhenEmpty) clearOpponentAnalysisWithoutMotion()
      return true
    }
    if (applyOptions.withoutMotion) suppressOpponentAnalysisMotion()
    shantenPredData.value = hasPredOpponents ? { ...predOpponents } : {}
    ronWaitPredData.value = hasPredRonWait ? { ...predRonWait } : {}
    shantenGTData.value = hasGtOpponents ? { ...gtOpponents } : {}
    ronWaitGTData.value = hasGtRonWait ? { ...gtRonWait } : {}
    return true
  }

  function invalidateOpponentRead() {
    shantenReadGeneration += 1
  }

  async function fetchShantenOnce() {
    if (clearingAnalysisCaches.value || !opponentAnalysisNeeded.value || !gameView.table || !window.trainerAPI?.getShanten) return
    const generation = ++shantenReadGeneration
    try {
      const result = await window.trainerAPI.getShanten()
      if (generation !== shantenReadGeneration || !opponentAnalysisNeeded.value) return
      applyShantenResult(result, { clearWhenEmpty: opponentAnalysisPermanentlyUnavailable.value })
    } catch (error) {
      if (generation !== shantenReadGeneration) return
      shantenStatus.value = `err: ${String(error)}`
    }
  }

  async function syncAnalysisVisibilityToBackend(refreshView = false): Promise<boolean> {
    if (!window.trainerAPI?.setAnalysisVisibility) return false
    const generation = ++analysisVisibilityGeneration
    try {
      const response = await window.trainerAPI.setAnalysisVisibility({
        decisionRecommendations: effectiveDecisionRecommendationsEnabled.value,
        opponentAnalysis: opponentAnalysisNeeded.value,
      })
      if (generation !== analysisVisibilityGeneration) return true
      applyStatus(response.state)
      if (refreshView) applyGameView(response.view)
      return true
    } catch {
      return generation !== analysisVisibilityGeneration
    }
  }

  async function toggleDecisionRecommendations(event?: Event) {
    if (status.mode !== 'research') return
    event?.preventDefault()
    event?.stopPropagation()
    const enabled = !decisionRecommendationsEnabled.value
    decisionRecommendationsEnabled.value = enabled
    if (!enabled) {
      decisionAnalysisEventCache.clear()
      gameView.analysis = null
    }
    if (await syncAnalysisVisibilityToBackend(true)) {
      if (opponentAnalysisNeeded.value) void fetchShantenOnce()
    } else decisionRecommendationsEnabled.value = !enabled
  }

  function cacheDecisionAnalysis(
    gameId: string | null | undefined,
    nodeId: string | null | undefined,
    analysis: DecisionAnalysis,
  ) {
    const key = decisionPositionKey(gameId, nodeId, status.controlledSeat)
    if (key) decisionAnalysisEventCache.set(key, analysis)
  }

  function resolveNextDecisionAnalysis(nextView: TrainerGameView, isNewGame: boolean): TrainerGameView['analysis'] {
    if (isNewGame) decisionAnalysisEventCache.clear()
    if (nextView.analysis) {
      cacheDecisionAnalysis(nextView.gameId, nextView.currentNodeId, nextView.analysis)
      return nextView.analysis
    }
    if (!effectiveDecisionRecommendationsEnabled.value || !nextView.legalActions.length) return null
    const key = decisionPositionKey(nextView.gameId, nextView.currentNodeId, status.controlledSeat)
    return key ? decisionAnalysisEventCache.get(key) || null : null
  }

  function resetForNewGame() {
    minimumDecisionCacheEpoch = null
    minimumOpponentCacheEpoch = null
    decisionAnalysisEventCache.clear()
  }

  function resetForBackendLifecycle() {
    minimumDecisionCacheEpoch = null
    minimumOpponentCacheEpoch = null
    invalidateOpponentRead()
    decisionAnalysisEventCache.clear()
    gameView.analysis = null
    gameView.opponentAnalysis = null
    clearOpponentAnalysisWithoutMotion()
  }

  function acceptsOpponentEventEpoch(epoch: unknown): boolean {
    return !clearingAnalysisCaches.value && acceptsAnalysisEpoch(epoch, minimumOpponentCacheEpoch)
  }

  function acceptsDecisionEventEpoch(epoch: unknown): boolean {
    return !clearingAnalysisCaches.value && acceptsAnalysisEpoch(epoch, minimumDecisionCacheEpoch)
  }

  function applyOpponentAnalysisEvent(result: Record<string, unknown>): boolean {
    if (clearingAnalysisCaches.value || !shantenResultMatchesCurrentPosition(result)) return false
    invalidateOpponentRead()
    return applyShantenResult(result)
  }

  async function clearLoadedAnalysisCaches() {
    if (!window.trainerAPI?.clearAnalysisCaches || clearingAnalysisCaches.value) return
    const gameId = gameView.gameId
    clearingAnalysisCaches.value = true
    invalidateOpponentRead()
    analysisCacheClearMessage.value = ''
    try {
      const response = await window.trainerAPI.clearAnalysisCaches()
      if (gameId !== gameView.gameId) return
      minimumDecisionCacheEpoch = response.cleared.decisionCacheEpoch
      minimumOpponentCacheEpoch = response.cleared.opponentCacheEpoch
      applyStatus(response.state)
      decisionAnalysisEventCache.clear()
      clearDecisionPresentation(response.cleared.treeRevision)
      invalidateOpponentRead()
      gameView.opponentAnalysis = null
      clearOpponentAnalysisWithoutMotion()
      shantenStatus.value = t('debug.cacheCleared')
      const { decisionEntries, opponentEntries, comparisons } = response.cleared
      analysisCacheClearMessage.value = t('debug.cacheSummary', {
        decision: decisionEntries,
        opponent: opponentEntries,
        comparisons,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      analysisCacheClearMessage.value = t('debug.clearFailed', { message })
    } finally {
      clearingAnalysisCaches.value = false
    }
  }

  watch(showAnalysisDock, async (open) => {
    await nextTick()
    scheduleTableZoomRecalc()
    if (!open) {
      await syncAnalysisVisibilityToBackend()
      return
    }
    if (await syncAnalysisVisibilityToBackend()) void fetchShantenOnce()
  })

  watch(
    () => [showTrainingRecommendations.value, effectiveDecisionRecommendationsEnabled.value, status.mode] as const,
    async ([, decisionEnabled, mode], [, previousDecisionEnabled, previousMode]) => {
      const modeChanged = mode !== previousMode
      if (decisionEnabled !== previousDecisionEnabled && !modeChanged) return
      if (await syncAnalysisVisibilityToBackend(modeChanged) && opponentAnalysisNeeded.value) {
        void fetchShantenOnce()
      }
    },
  )

  return {
    SHANTEN_LABELS,
    acceptsDecisionEventEpoch,
    acceptsOpponentEventEpoch,
    analysisCacheClearMessage,
    applyOpponentAnalysisEvent,
    applyShantenResult,
    cacheDecisionAnalysis,
    canToggleDecisionRecommendations,
    clearLoadedAnalysisCaches,
    clearOpponentAnalysisWithoutMotion,
    clearingAnalysisCaches,
    decisionRecommendationsEnabled,
    effectiveDecisionRecommendationsEnabled,
    fetchShantenOnce,
    hasOpponentGroundTruth,
    invalidateOpponentRead,
    opponentAnalysisIsLoading,
    opponentAnalysisLoadError,
    opponentAnalysisNeeded,
    opponentAnalysisPermanentlyUnavailable,
    resetForBackendLifecycle,
    resetForNewGame,
    resolveNextDecisionAnalysis,
    ronWaitPredData,
    shantenOpponents,
    shantenRawData,
    shantenRawJson,
    shantenStatus,
    shantenViewMode,
    showTrainingRecommendations,
    suppressOpponentAnalysisTransitions,
    syncAnalysisVisibilityToBackend,
    toggleDecisionRecommendations,
  }
}
