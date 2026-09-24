import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import { acceptsAnalysisEpoch } from './analysisEpoch.ts'
import { decisionPositionKey } from './analysisPosition.ts'
import type { TranslationParams } from './i18n'
import type { StudioSettings } from './contracts/settings'
import type { GameView, TableState } from './contracts/game'
import type { StudioStatus } from './contracts/runtime'
import { normalizeTrainingMode } from './trainingSettings.ts'
import { getUiMotionDurationMs } from './uiMotion.ts'

type Translate = (key: string, params?: TranslationParams) => string
type DecisionAnalysis = NonNullable<GameView['analysis']>

interface UseAnalysisSessionOptions {
  settings: StudioSettings
  status: StudioStatus
  gameView: GameView
  showAnalysisDock: Readonly<Ref<boolean>>
  t: Translate
  applyStatus: (status: StudioStatus) => void
  applyGameView: (view: GameView) => void
  scheduleTableZoomRecalc: () => void
  clearDecisionPresentation: (treeRevision: number) => void
}

export const SHANTEN_SHORT_LABELS = ['0', '1', '2', '3', '4', '5', '6', 'X']

function hasShantenRows(group: Record<string, number[]> | undefined): group is Record<string, number[]> {
  return Boolean(group && Object.values(group).some((values) => Array.isArray(values) && values.length > 0))
}

export function analysisResultHasRows(result: Record<string, unknown> | null | undefined): boolean {
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
  const suppressAnalysisTransitions = ref(false)
  const shantenRawData = ref<Record<string, Record<string, unknown>>>({})
  const shantenRawJson = computed(() => JSON.stringify(shantenRawData.value, null, 2))
  const shantenStatus = ref('—')
  const displayedOpponentAnalysis = ref<Record<string, unknown> | null>(null)
  const displayedAnalysisTable = shallowRef<TableState | null>(null)
  const displayedAnalysisControlledSeat = ref(status.controlledSeat)
  const opponentAnalysisPending = ref(false)
  const opponentAnalysisLoadingVisible = ref(false)
  const clearingAnalysisCaches = ref(false)
  const analysisCacheClearMessage = ref('')
  let analysisTransitionResetGeneration = 0
  let analysisTransitionStartFrame = 0
  let analysisTransitionEndFrame = 0
  let minimumDecisionCacheEpoch: number | null = null
  let minimumOpponentCacheEpoch: number | null = null
  let analysisReadGeneration = 0
  let analysisVisibilityGeneration = 0
  let analysisLoadingTimer: number | null = null
  let analysisPresentationTimer: number | null = null
  let analysisPresentationStartFrame = 0
  let analysisPresentationCommitFrame = 0
  let analysisPresentationNotBefore: number | null = 0
  let pendingAnalysisPresentation: {
    result: Record<string, unknown>
    withoutMotion: boolean
    clearWhenEmpty: boolean
  } | null = null

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
  const hasOpponentAnalysisResult = computed(() => analysisResultHasRows(gameView.opponentAnalysis))
  const hasDisplayedOpponentAnalysis = computed(() => (
    analysisResultHasRows(displayedOpponentAnalysis.value)
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
    if (opponentAnalysisPending.value) return true
    return !hasOpponentAnalysisResult.value
      && (activity === 'running' || gameView.opponentAnalysis?.status === 'loading')
  })
  const analysisOpponents = computed(() => {
    const controlledSeat = displayedAnalysisControlledSeat.value
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

  function analysisResultMatchesCurrentPosition(result: Record<string, unknown>): boolean {
    const context = result.context as Record<string, unknown> | undefined
    if (!context || !acceptsAnalysisEpoch(context.cacheEpoch, minimumOpponentCacheEpoch)) return false
    return context.gameId === gameView.gameId
      && context.nodeId === gameView.currentNodeId
      && Number(context.seat) === status.controlledSeat
  }

  function cancelAnalysisTransitionReset() {
    window.cancelAnimationFrame(analysisTransitionStartFrame)
    window.cancelAnimationFrame(analysisTransitionEndFrame)
    analysisTransitionStartFrame = 0
    analysisTransitionEndFrame = 0
  }

  function suppressAnalysisMotion() {
    const resetGeneration = ++analysisTransitionResetGeneration
    suppressAnalysisTransitions.value = true
    cancelAnalysisTransitionReset()
    void nextTick(() => {
      if (resetGeneration !== analysisTransitionResetGeneration) return
      analysisTransitionStartFrame = window.requestAnimationFrame(() => {
        analysisTransitionStartFrame = 0
        analysisTransitionEndFrame = window.requestAnimationFrame(() => {
          analysisTransitionEndFrame = 0
          if (resetGeneration !== analysisTransitionResetGeneration) return
          suppressAnalysisTransitions.value = false
        })
      })
    })
  }

  function clearOpponentAnalysisWithoutMotion() {
    suppressAnalysisMotion()
    cancelScheduledAnalysisPresentation()
    analysisPresentationNotBefore = 0
    shantenPredData.value = {}
    shantenGTData.value = {}
    ronWaitPredData.value = {}
    ronWaitGTData.value = {}
    shantenRawData.value = {}
    shantenStatus.value = '—'
    displayedOpponentAnalysis.value = null
    displayedAnalysisTable.value = null
    displayedAnalysisControlledSeat.value = status.controlledSeat
    finishOpponentAnalysisPending()
  }

  function cancelAnalysisLoadingTimer() {
    if (analysisLoadingTimer !== null) window.clearTimeout(analysisLoadingTimer)
    analysisLoadingTimer = null
  }

  function cancelScheduledAnalysisPresentation() {
    if (analysisPresentationTimer !== null) window.clearTimeout(analysisPresentationTimer)
    window.cancelAnimationFrame(analysisPresentationStartFrame)
    window.cancelAnimationFrame(analysisPresentationCommitFrame)
    analysisPresentationTimer = null
    analysisPresentationStartFrame = 0
    analysisPresentationCommitFrame = 0
    pendingAnalysisPresentation = null
  }

  function finishOpponentAnalysisPending() {
    opponentAnalysisPending.value = false
    opponentAnalysisLoadingVisible.value = false
    cancelAnalysisLoadingTimer()
  }

  function beginOpponentAnalysisPending() {
    opponentAnalysisPending.value = true
    restartAnalysisLoadingFeedback()
  }

  function restartAnalysisLoadingFeedback() {
    cancelAnalysisLoadingTimer()
    if (!opponentAnalysisIsLoading.value) {
      opponentAnalysisLoadingVisible.value = false
      return
    }
    if (!hasDisplayedOpponentAnalysis.value) {
      opponentAnalysisLoadingVisible.value = true
      return
    }
    opponentAnalysisLoadingVisible.value = false
    analysisLoadingTimer = window.setTimeout(() => {
      analysisLoadingTimer = null
      if (opponentAnalysisIsLoading.value) opponentAnalysisLoadingVisible.value = true
    }, 500)
  }

  function applyAnalysisResult(
    result: Record<string, unknown>,
    applyOptions: { withoutMotion?: boolean; clearWhenEmpty?: boolean } = {},
  ): boolean {
    if (!analysisResultMatchesCurrentPosition(result)) return false
    gameView.opponentAnalysis = result
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
      else if (result.status !== 'loading') finishOpponentAnalysisPending()
      return true
    }
    if (applyOptions.withoutMotion && !suppressAnalysisTransitions.value) suppressAnalysisMotion()
    shantenPredData.value = hasPredOpponents ? { ...predOpponents } : {}
    ronWaitPredData.value = hasPredRonWait ? { ...predRonWait } : {}
    shantenGTData.value = hasGtOpponents ? { ...gtOpponents } : {}
    ronWaitGTData.value = hasGtRonWait ? { ...gtRonWait } : {}
    // Keep the result and the table state that gives it meaning in one
    // presentation snapshot. During a round transition the live table already
    // belongs to the next round while the previous result is deliberately
    // retained for the short handoff window.
    displayedAnalysisTable.value = gameView.table
    displayedAnalysisControlledSeat.value = status.controlledSeat
    displayedOpponentAnalysis.value = result
    finishOpponentAnalysisPending()
    return true
  }

  function presentScheduledAnalysis() {
    analysisPresentationTimer = null
    const pending = pendingAnalysisPresentation
    pendingAnalysisPresentation = null
    if (!pending) return
    applyAnalysisResult(pending.result, {
      withoutMotion: pending.withoutMotion,
      clearWhenEmpty: pending.clearWhenEmpty,
    })
  }

  function armScheduledAnalysisPresentation() {
    if (!pendingAnalysisPresentation || analysisPresentationNotBefore === null) return
    if (analysisPresentationTimer !== null) window.clearTimeout(analysisPresentationTimer)
    const delay = pendingAnalysisPresentation.withoutMotion
      ? 0
      : Math.max(0, analysisPresentationNotBefore - performance.now())
    if (delay <= 0) presentScheduledAnalysis()
    else analysisPresentationTimer = window.setTimeout(presentScheduledAnalysis, delay)
  }

  function beginAnalysisPresentationWindow() {
    analysisPresentationNotBefore = null
    void nextTick(() => {
      analysisPresentationStartFrame = window.requestAnimationFrame((frameTime) => {
        analysisPresentationStartFrame = 0
        analysisPresentationCommitFrame = window.requestAnimationFrame((committedFrameTime) => {
          analysisPresentationCommitFrame = 0
          analysisPresentationNotBefore = committedFrameTime + getUiMotionDurationMs()
          armScheduledAnalysisPresentation()
        })
      })
    })
  }

  function scheduleAnalysisPresentation(
    result: Record<string, unknown>,
    presentationOptions: { withoutMotion?: boolean; clearWhenEmpty?: boolean } = {},
  ): boolean {
    if (!analysisResultMatchesCurrentPosition(result)) return false
    gameView.opponentAnalysis = result
    if (result.status === 'terminal') {
      clearOpponentAnalysisWithoutMotion()
      return true
    }
    const withoutMotion = Boolean(presentationOptions.withoutMotion)
    pendingAnalysisPresentation = {
      result,
      withoutMotion,
      clearWhenEmpty: Boolean(presentationOptions.clearWhenEmpty),
    }
    armScheduledAnalysisPresentation()
    return true
  }

  function stageOpponentAnalysisForView(
    result: Record<string, unknown> | null | undefined,
    stageOptions: { resetDisplay?: boolean; withoutMotion?: boolean } = {},
  ) {
    cancelScheduledAnalysisPresentation()
    if (stageOptions.resetDisplay) clearOpponentAnalysisWithoutMotion()
    if (stageOptions.withoutMotion || stageOptions.resetDisplay) analysisPresentationNotBefore = 0
    else beginAnalysisPresentationWindow()
    gameView.opponentAnalysis = result || null
    if (result?.status === 'terminal') {
      clearOpponentAnalysisWithoutMotion()
      return
    }
    if (!result) {
      if (opponentAnalysisNeeded.value && gameView.table && !opponentAnalysisPermanentlyUnavailable.value) {
        beginOpponentAnalysisPending()
      }
      else finishOpponentAnalysisPending()
      return
    }

    // Let the table commit and start its compositor animations before the
    // comparatively large analysis DOM is replaced.
    beginOpponentAnalysisPending()
    scheduleAnalysisPresentation(result, { withoutMotion: stageOptions.withoutMotion })
  }

  function invalidateOpponentRead() {
    analysisReadGeneration += 1
  }

  async function fetchAnalysisOnce() {
    if (clearingAnalysisCaches.value || !opponentAnalysisNeeded.value || !gameView.table || !window.studioAPI?.getAnalysis) return
    const generation = ++analysisReadGeneration
    try {
      const result = await window.studioAPI.getAnalysis()
      if (generation !== analysisReadGeneration || !opponentAnalysisNeeded.value) return
      if (!scheduleAnalysisPresentation(result, {
        withoutMotion: opponentAnalysisPermanentlyUnavailable.value,
        clearWhenEmpty: opponentAnalysisPermanentlyUnavailable.value,
      })) return
    } catch (error) {
      if (generation !== analysisReadGeneration) return
      shantenStatus.value = `err: ${String(error)}`
      finishOpponentAnalysisPending()
    }
  }

  async function syncAnalysisVisibilityToBackend(refreshView = false): Promise<boolean> {
    if (!window.studioAPI?.setAnalysisVisibility) return false
    const generation = ++analysisVisibilityGeneration
    try {
      const response = await window.studioAPI.setAnalysisVisibility({
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
      if (opponentAnalysisNeeded.value) void fetchAnalysisOnce()
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

  function resolveNextDecisionAnalysis(nextView: GameView, isNewGame: boolean): GameView['analysis'] {
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
    if (clearingAnalysisCaches.value || !analysisResultMatchesCurrentPosition(result)) return false
    invalidateOpponentRead()
    return scheduleAnalysisPresentation(result)
  }

  async function clearLoadedAnalysisCaches() {
    if (!window.studioAPI?.clearAnalysisCaches || clearingAnalysisCaches.value) return
    const gameId = gameView.gameId
    clearingAnalysisCaches.value = true
    invalidateOpponentRead()
    analysisCacheClearMessage.value = ''
    try {
      const response = await window.studioAPI.clearAnalysisCaches()
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
    if (await syncAnalysisVisibilityToBackend()) void fetchAnalysisOnce()
  })

  watch(
    () => [showTrainingRecommendations.value, effectiveDecisionRecommendationsEnabled.value, status.mode] as const,
    async ([, decisionEnabled, mode], [, previousDecisionEnabled, previousMode]) => {
      const modeChanged = mode !== previousMode
      if (decisionEnabled !== previousDecisionEnabled && !modeChanged) return
      if (await syncAnalysisVisibilityToBackend(modeChanged) && opponentAnalysisNeeded.value) {
        void fetchAnalysisOnce()
      }
    },
  )

  watch(opponentAnalysisIsLoading, (loading) => {
    if (loading) restartAnalysisLoadingFeedback()
    else finishOpponentAnalysisPending()
  }, { immediate: true })

  onBeforeUnmount(() => {
    analysisTransitionResetGeneration += 1
    cancelAnalysisTransitionReset()
    cancelAnalysisLoadingTimer()
    cancelScheduledAnalysisPresentation()
  })

  return {
    SHANTEN_LABELS,
    acceptsDecisionEventEpoch,
    acceptsOpponentEventEpoch,
    analysisCacheClearMessage,
    applyOpponentAnalysisEvent,
    applyAnalysisResult,
    cacheDecisionAnalysis,
    canToggleDecisionRecommendations,
    clearLoadedAnalysisCaches,
    clearOpponentAnalysisWithoutMotion,
    clearingAnalysisCaches,
    decisionRecommendationsEnabled,
    displayedOpponentAnalysis,
    displayedAnalysisTable,
    displayedAnalysisControlledSeat,
    effectiveDecisionRecommendationsEnabled,
    fetchAnalysisOnce,
    hasOpponentGroundTruth,
    invalidateOpponentRead,
    opponentAnalysisIsLoading,
    opponentAnalysisLoadingVisible,
    opponentAnalysisLoadError,
    opponentAnalysisNeeded,
    opponentAnalysisPermanentlyUnavailable,
    resetForBackendLifecycle,
    resetForNewGame,
    resolveNextDecisionAnalysis,
    stageOpponentAnalysisForView,
    ronWaitPredData,
    analysisOpponents,
    shantenRawData,
    shantenRawJson,
    shantenStatus,
    shantenViewMode,
    showTrainingRecommendations,
    suppressAnalysisTransitions,
    syncAnalysisVisibilityToBackend,
    toggleDecisionRecommendations,
  }
}
