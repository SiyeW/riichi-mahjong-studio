import { ref, type Ref } from 'vue'
import type { GameAction, GameView } from './contracts/game'
import type { BackendResponse, StudioStatus } from './contracts/runtime'

interface UseGameplayActionsOptions {
  gameView: GameView
  status: StudioStatus
  readOnlyRecord: Readonly<Ref<boolean>>
  prefetchReady: Readonly<Ref<boolean>>
  applyStatus: (status: StudioStatus) => void
  applyGameView: (view: GameView) => void
  applyPlayPrefetchStatus: (prefetch?: BackendResponse['playPrefetch']) => void
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
    if (!window.studioAPI || actionRequestInFlight.value || !isUserDiscard(tile, options.status.controlledSeat)) return
    if (options.readOnlyRecord.value || options.status.mode !== 'play') return
    const requestGeneration = responseGeneration
    actionRequestInFlight.value = true
    try {
      const response = await window.studioAPI.submitUserAction({ type: 'dahai', pai: tile, fromDrawn })
      if (requestGeneration !== responseGeneration) return
      options.applyStatus(response.state)
      options.applyGameView(response.view)
      options.applyPlayPrefetchStatus(response.playPrefetch)
    } finally {
      actionRequestInFlight.value = false
    }
  }

  async function submitAction(action: GameAction) {
    if (!window.studioAPI || actionRequestInFlight.value || options.readOnlyRecord.value || options.status.mode !== 'play') return
    if (action.type === 'dahai') {
      await discardTile(action.pai || '', Boolean(action.tsumogiri))
      return
    }
    const requestGeneration = responseGeneration
    actionRequestInFlight.value = true
    try {
      const response = await window.studioAPI.submitUserAction({
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
    if (!window.studioAPI || options.readOnlyRecord.value || advanceRequestInFlight.value || options.status.mode !== 'play') return
    const requestGeneration = responseGeneration
    advanceRequestInFlight.value = true
    options.beginPlayPrefetchAdvance()
    try {
      const response = await window.studioAPI.advanceGame()
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
    if (!window.studioAPI || options.readOnlyRecord.value || options.status.mode !== 'play') return
    const requestGeneration = responseGeneration
    const response = await window.studioAPI.confirmPendingReview()
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
