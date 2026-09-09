import { ref } from 'vue'
import type { EnvironmentResponse } from './contracts/runtime'

interface UsePlayPrefetchOptions {
  currentPosition: () => { gameId: string | null | undefined; nodeId: string | null | undefined }
  onCurrentStatusChanged: () => void
}

export function playPrefetchPositionKey(
  gameId: string | null | undefined,
  nodeId: string | null | undefined,
): string | null {
  if (!gameId || !nodeId) return null
  return `${gameId}\u0000${nodeId}`
}

export function usePlayPrefetch(options: UsePlayPrefetchOptions) {
  const playPrefetchReady = ref(false)
  const playPrefetchWaiting = ref(false)
  const earlyReadyPositions = new Set<string>()

  function applyPlayPrefetchStatus(prefetch?: EnvironmentResponse['playPrefetch']) {
    const current = options.currentPosition()
    const key = playPrefetchPositionKey(current.gameId, current.nodeId)
    const eventReady = key ? earlyReadyPositions.delete(key) : false
    playPrefetchReady.value = Boolean(prefetch?.ready || eventReady)
    playPrefetchWaiting.value = Boolean(prefetch?.waiting && !playPrefetchReady.value)
    options.onCurrentStatusChanged()
  }

  function activatePlayPrefetchPosition(gameId: string | null | undefined, nodeId: string | null | undefined) {
    const key = playPrefetchPositionKey(gameId, nodeId)
    if (!key || !earlyReadyPositions.has(key)) return
    playPrefetchReady.value = true
    playPrefetchWaiting.value = false
  }

  function markPlayPrefetchReady(gameId: string | null | undefined, nodeId: string | null | undefined) {
    const key = playPrefetchPositionKey(gameId, nodeId)
    if (!key) return
    earlyReadyPositions.add(key)
    const current = options.currentPosition()
    if (gameId !== current.gameId || nodeId !== current.nodeId) return
    playPrefetchReady.value = true
    playPrefetchWaiting.value = false
    options.onCurrentStatusChanged()
  }

  function beginPlayPrefetchAdvance() {
    playPrefetchReady.value = false
    const current = options.currentPosition()
    const key = playPrefetchPositionKey(current.gameId, current.nodeId)
    if (key) earlyReadyPositions.delete(key)
  }

  function resetPlayPrefetch() {
    earlyReadyPositions.clear()
    playPrefetchReady.value = false
    playPrefetchWaiting.value = false
  }

  return {
    activatePlayPrefetchPosition,
    applyPlayPrefetchStatus,
    beginPlayPrefetchAdvance,
    markPlayPrefetchReady,
    playPrefetchReady,
    playPrefetchWaiting,
    resetPlayPrefetch,
  }
}
