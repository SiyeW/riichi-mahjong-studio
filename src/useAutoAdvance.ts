import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { StudioSettings } from './contracts/settings'

const ANKAN_CHOICE_TIMEOUT_MS = 6000

interface AutoAdvanceState {
  controlledSeat: number
  defaultDelayMs: number
  legalActionCount: number
  mode: TrainerStatusSnapshot['mode']
  pendingReview: boolean
  prefetchReady: boolean
  prefetchWaiting: boolean
  readOnly: boolean
  table: TrainerGameView['table']
}

interface UseAutoAdvanceOptions {
  gameView: TrainerGameView
  status: TrainerStatusSnapshot
  settings: StudioSettings
  readOnlyRecord: Readonly<Ref<boolean>>
  prefetchReady: Readonly<Ref<boolean>>
  prefetchWaiting: Readonly<Ref<boolean>>
  motionDelayMs: () => number
  hasPendingMotion: () => boolean
  advance: () => void | Promise<void>
}

export function resolveAutoAdvanceDelay(state: AutoAdvanceState): number | null {
  const table = state.table
  if (state.mode !== 'play' || state.pendingReview || state.readOnly) return null
  if (table?.resultInfo || table?.phase === 'round_result' || table?.phase === 'match_end') return null
  const delay = state.defaultDelayMs
  if (state.prefetchReady) return delay
  if (state.prefetchWaiting) return null
  if (table?.autoAdvanceMode === 'ai_think') return 0
  if (table?.phase === 'game_end') return delay
  if (table?.phase === 'reach_declaration') return state.legalActionCount > 0 ? null : delay
  if (table?.phase === 'draw_or_discard' && table.currentActor === state.controlledSeat) return 30
  if (table?.riichiDiscardState === 'pending_pause') return delay
  if (table?.riichiDiscardState === 'ankan_choice') return ANKAN_CHOICE_TIMEOUT_MS
  if (table?.riichiAccepted?.[state.controlledSeat]
    && table.riichiDiscardState == null
    && state.legalActionCount === 0) return delay
  if (state.legalActionCount > 0) return null
  if (table
    && (table.phase === 'discard' || table.phase === 'draw_or_discard')
    && table.currentActor !== state.controlledSeat) return delay
  if (table?.reactionWindow) {
    return Math.max(delay, Math.round((table.reactionWindow.thinkingTimeS || 0) * 1000))
  }
  if (table?.kanReactionWindow) {
    return Math.max(delay, Math.round((table.kanReactionWindow.thinkingTimeS || 0) * 1000))
  }
  return null
}

export function useAutoAdvance(options: UseAutoAdvanceOptions) {
  const timer = ref<number | null>(null)

  function clearAutoAdvanceTimer() {
    if (timer.value === null) return
    window.clearTimeout(timer.value)
    timer.value = null
  }

  function scheduleAutoAdvance() {
    clearAutoAdvanceTimer()
    if (!window.trainerAPI) return
    const delay = resolveAutoAdvanceDelay({
      controlledSeat: options.status.controlledSeat,
      defaultDelayMs: options.settings.modeDefaults.autoAdvanceDelayMs,
      legalActionCount: options.gameView.legalActions.length,
      mode: options.status.mode,
      pendingReview: Boolean(options.gameView.pendingReview),
      prefetchReady: options.prefetchReady.value,
      prefetchWaiting: options.prefetchWaiting.value,
      readOnly: options.readOnlyRecord.value,
      table: options.gameView.table,
    })
    if (delay === null) return
    timer.value = window.setTimeout(() => {
      timer.value = null
      if (options.hasPendingMotion()) return
      void options.advance()
    }, Math.max(delay, options.motionDelayMs()))
  }

  watch(
    () => [
      options.gameView.currentNodeId,
      options.gameView.table?.phase,
      options.gameView.table?.autoAdvanceMode,
      options.gameView.table?.riichiDiscardState,
      options.gameView.table?.reactionWindow,
      options.gameView.table?.kanReactionWindow,
      options.gameView.legalActions.length,
      options.gameView.pendingReview?.proposedNodeId,
      options.status.mode,
    ],
    scheduleAutoAdvance,
  )
  onBeforeUnmount(clearAutoAdvanceTimer)

  return { clearAutoAdvanceTimer, scheduleAutoAdvance }
}
