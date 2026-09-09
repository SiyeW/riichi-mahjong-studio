import type { Ref } from 'vue'
import { backendStoppedState } from './backendStoppedState.ts'
import { applyModelActivityEvent } from './modelActivityEvent.ts'
import { shantenResultHasRows } from './useAnalysisSession.ts'
import type { GameTreeNode } from './contracts/game'

type Translate = (key: string, params?: Record<string, string | number>) => string

export interface PythonEventRouterOptions {
  status: TrainerStatusSnapshot
  gameView: TrainerGameView
  bootstrapError: Ref<string>
  backendRecoveryNeeded: Ref<boolean>
  backendHasCheckpoint: Ref<boolean>
  clearingAnalysisCaches: Readonly<Ref<boolean>>
  effectiveDecisionRecommendationsEnabled: Readonly<Ref<boolean>>
  nodeMapById: Readonly<Ref<ReadonlyMap<string, GameTreeNode>>>
  t: Translate
  applyStatus: (status: TrainerStatusSnapshot) => void
  applyGameView: (view: TrainerGameView) => void
  clearRecordMetadata: () => void
  resetForBackendLifecycle: () => void
  invalidateGameplayResponses: () => void
  invalidateNavigation: () => void
  clearAutoAdvanceTimer: () => void
  resetPlayPrefetch: () => void
  acceptsOpponentEventEpoch: (epoch: unknown) => boolean
  acceptsDecisionEventEpoch: (epoch: unknown) => boolean
  markPlayPrefetchReady: (gameId: string, nodeId: string) => void
  clearOpponentAnalysisWithoutMotion: () => void
  fetchShantenOnce: () => Promise<unknown>
  applyOpponentAnalysisEvent: (analysis: NonNullable<TrainerGameView['opponentAnalysis']>) => void
  cacheDecisionAnalysis: (
    gameId: string | null | undefined,
    nodeId: string | null | undefined,
    analysis: NonNullable<TrainerGameView['analysis']>,
  ) => void
}

function eventMatchesGame(event: TrainerPythonEvent, gameId: string | null | undefined): boolean {
  return !event.gameId || event.gameId === gameId
}

function eventMatchesCurrentAnalysisView(
  event: TrainerPythonEvent,
  gameView: TrainerGameView,
  controlledSeat: number,
): boolean {
  if (!eventMatchesGame(event, gameView.gameId)) return false
  if (event.nodeId && event.nodeId !== gameView.currentNodeId) return false
  return !Number.isInteger(event.seat) || Number(event.seat) === controlledSeat
}

function applyTreeUpdates(
  event: TrainerPythonEvent,
  gameView: TrainerGameView,
  nodeMapById: ReadonlyMap<string, GameTreeNode>,
) {
  event.treeComparisons?.forEach((update) => {
    const node = nodeMapById.get(update.id)
    if (node) node.comparison = update.comparison
  })
  if (gameView.tree && typeof event.treeRevision === 'number') {
    gameView.tree.revision = event.treeRevision
  }
}

export function createPythonEventRouter(options: PythonEventRouterOptions) {
  return function handlePythonEvent(event: TrainerPythonEvent) {
    if (event.type === 'service_recovery_failed') {
      options.bootstrapError.value = options.t('recovery.failed', { message: event.error || '' })
      return
    }

    if (event.type === 'service_restored') {
      if (event.state && event.view) {
        options.applyStatus(event.state)
        options.applyGameView(event.view)
        if (!event.state.gameLoaded) options.clearRecordMetadata()
        options.backendRecoveryNeeded.value = false
        options.bootstrapError.value = ''
      }
      return
    }

    if (event.type === 'service_ready' || event.type === 'service_stopped') {
      options.resetForBackendLifecycle()
      options.invalidateGameplayResponses()
      options.invalidateNavigation()
      if (event.type === 'service_stopped') {
        options.backendRecoveryNeeded.value = true
        options.backendHasCheckpoint.value = Boolean(event.hasCheckpoint)
        options.applyStatus(backendStoppedState(options.status))
        options.clearAutoAdvanceTimer()
        options.resetPlayPrefetch()
        options.bootstrapError.value = options.t('recovery.stopped')
      }
      return
    }

    if (event.type === 'opponent_analysis_ready') {
      const context = event.opponentAnalysis?.context as Record<string, unknown> | undefined
      if (!options.acceptsOpponentEventEpoch(context?.cacheEpoch)) return
    }
    if (
      (event.type === 'analysis_ready' || event.type === 'auto_analysis_tree_updates')
      && !options.acceptsDecisionEventEpoch(event.cacheEpoch)
    ) return

    if (event.type === 'auto_analysis_progress' && event.autoAnalysis) {
      if (!eventMatchesGame(event, options.gameView.gameId)) return
      options.status.autoAnalysis = { ...event.autoAnalysis }
      return
    }
    if (event.type === 'play_prefetch_ready' && event.gameId && event.nodeId) {
      options.markPlayPrefetchReady(event.gameId, event.nodeId)
      return
    }
    if (!eventMatchesGame(event, options.gameView.gameId)) return

    if (event.autoAnalysis) {
      options.status.autoAnalysis = { ...event.autoAnalysis }
    } else if (event.state?.autoAnalysis) {
      options.status.autoAnalysis = { ...event.state.autoAnalysis }
    }

    if (event.type === 'auto_analysis_tree_updates') {
      applyTreeUpdates(event, options.gameView, options.nodeMapById.value)
      return
    }
    if (event.type === 'model_activity') {
      const { opponentFailed } = applyModelActivityEvent(options.status, event, options.t('error.unknown'))
      if (opponentFailed) {
        if (!shantenResultHasRows(options.gameView.opponentAnalysis)) {
          options.clearOpponentAnalysisWithoutMotion()
        }
        void options.fetchShantenOnce()
      }
      return
    }
    if (
      event.type === 'opponent_analysis_ready'
      && event.opponentAnalysis
      && eventMatchesCurrentAnalysisView(event, options.gameView, options.status.controlledSeat)
    ) {
      options.applyOpponentAnalysisEvent(event.opponentAnalysis)
      return
    }
    if (event.type !== 'analysis_ready' || !event.nodeId || !event.analysis) return
    if (options.clearingAnalysisCaches.value || !options.effectiveDecisionRecommendationsEnabled.value) return

    const analysisSeat = typeof event.analysis.seat === 'number'
      ? Number(event.analysis.seat)
      : null
    if (analysisSeat !== null && analysisSeat !== options.status.controlledSeat) return
    if (event.state) options.applyStatus(event.state as TrainerStatusSnapshot)
    applyTreeUpdates(event, options.gameView, options.nodeMapById.value)

    const analysis = event.analysis as NonNullable<TrainerGameView['analysis']>
    options.cacheDecisionAnalysis(event.gameId || options.gameView.gameId, event.nodeId, analysis)
    if (event.nodeId === options.gameView.currentNodeId) options.gameView.analysis = analysis
  }
}
