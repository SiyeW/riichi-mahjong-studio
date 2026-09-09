import { ref, type Ref } from 'vue'
import type { GameAction } from './contracts/game'

interface UseGameplayActionsOptions {
  gameView: TrainerGameView
  status: TrainerStatusSnapshot
  readOnlyRecord: Readonly<Ref<boolean>>
  prefetchReady: Readonly<Ref<boolean>>
  applyStatus: (status: TrainerStatusSnapshot) => void
  applyGameView: (view: TrainerGameView) => void
  applyPlayPrefetchStatus: (prefetch?: TrainerEnvironmentResponse['playPrefetch']) => void
  beginPlayPrefetchAdvance: () => void
  scheduleAutoAdvance: () => void
}

export function useGameplayActions(options: UseGameplayActionsOptions) {
  const actionRequestInFlight = ref(false)
  const advanceRequestInFlight = ref(false)
  let responseGeneration = 0

  function currentGameplayResponseGeneration() {
    return responseGeneration
  }

  function invalidateGameplayResponses() {
    responseGeneration += 1
  }

  function isUserDiscard(tile: string, seat: number): boolean {
    return seat === options.status.controlledSeat
      && options.gameView.table?.currentActor === seat
      && options.gameView.legalActions.some((action) => action.type === 'dahai' && action.pai === tile)
  }

  async function discardTile(tile: string, fromDrawn = false) {
    if (!window.trainerAPI || actionRequestInFlight.value || !isUserDiscard(tile, options.status.controlledSeat)) return
    if (options.readOnlyRecord.value || options.status.mode !== 'play') return
    const requestGeneration = responseGeneration
    actionRequestInFlight.value = true
    try {
      const response = await window.trainerAPI.submitUserAction({ type: 'dahai', pai: tile, fromDrawn })
      if (requestGeneration !== responseGeneration) return
      options.applyStatus(response.state)
      options.applyGameView(response.view)
      options.applyPlayPrefetchStatus(response.playPrefetch)
    } finally {
      actionRequestInFlight.value = false
    }
  }

  async function submitAction(action: GameAction) {
    if (!window.trainerAPI || actionRequestInFlight.value || options.readOnlyRecord.value || options.status.mode !== 'play') return
    if (action.type === 'dahai') {
      await discardTile(action.pai || '', Boolean(action.tsumogiri))
      return
    }
    const requestGeneration = responseGeneration
    actionRequestInFlight.value = true
    try {
      const response = await window.trainerAPI.submitUserAction({
        type: action.type,
        variant: action.variant,
        candidateId: action.candidateId || action.id,
      })
      if (requestGeneration !== responseGeneration) return
      options.applyStatus(response.state)
      options.applyGameView(response.view)
      options.applyPlayPrefetchStatus(response.playPrefetch)
    } finally {
      actionRequestInFlight.value = false
    }
  }

  async function advanceGame() {
    if (!window.trainerAPI || options.readOnlyRecord.value || advanceRequestInFlight.value || options.status.mode !== 'play') return
    const requestGeneration = responseGeneration
    advanceRequestInFlight.value = true
    options.beginPlayPrefetchAdvance()
    try {
      const response = await window.trainerAPI.advanceGame()
      if (requestGeneration !== responseGeneration) return
      options.applyStatus(response.state)
      if (response.playPrefetch?.committed !== false) options.applyGameView(response.view)
      options.applyPlayPrefetchStatus(response.playPrefetch)
    } finally {
      advanceRequestInFlight.value = false
      if (options.prefetchReady.value) options.scheduleAutoAdvance()
    }
  }

  async function confirmPendingReview() {
    if (!window.trainerAPI || options.readOnlyRecord.value || options.status.mode !== 'play') return
    const requestGeneration = responseGeneration
    const response = await window.trainerAPI.confirmPendingReview()
    if (requestGeneration !== responseGeneration) return
    options.applyStatus(response.state)
    options.applyGameView(response.view)
    options.applyPlayPrefetchStatus(response.playPrefetch)
  }

  return {
    advanceGame,
    confirmPendingReview,
    currentGameplayResponseGeneration,
    discardTile,
    invalidateGameplayResponses,
    isUserDiscard,
    submitAction,
  }
}
