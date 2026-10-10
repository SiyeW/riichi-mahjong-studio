import { reactive, ref, watch } from 'vue'
import type { GameView } from './contracts/game'

export function usePlayerNames(gameView: GameView, markDirty: () => void) {
  const drafts = reactive(new Map<number, string>())
  const error = ref('')
  let pending: Promise<void> | null = null

  function draft(seat: number, name: string) {
    drafts.set(seat, name)
    markDirty()
  }

  async function flush(): Promise<void> {
    if (pending) {
      await pending
      return flush()
    }
    if (!drafts.size) return
    const gameId = gameView.gameId
    const saving = async () => {
      for (const [seat, name] of [...drafts]) {
        if (gameView.gameId !== gameId) return
        if (!window.studioAPI) throw new Error('Studio bridge unavailable')
        const result = await window.studioAPI.setPlayerName(seat, name)
        if (gameView.gameId !== gameId) return
        const names = [...(gameView.playerNames || ['', '', '', ''])]
        names[seat] = result.name
        gameView.playerNames = names
        if (drafts.get(seat) === name) drafts.delete(seat)
      }
    }
    pending = saving()
    try {
      await pending
      if (gameView.gameId === gameId) error.value = ''
    } catch (failure) {
      if (gameView.gameId === gameId) error.value = failure instanceof Error ? failure.message : String(failure)
      throw failure
    } finally {
      pending = null
    }
    if (drafts.size) await flush()
  }

  watch(() => gameView.gameId, () => {
    drafts.clear()
    error.value = ''
  }, { flush: 'sync' })
  return { drafts, error, draft, flush, cancel: (seat: number) => drafts.delete(seat) }
}
