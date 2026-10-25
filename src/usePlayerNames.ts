import { reactive, ref, watch } from 'vue'
import type { GameView, RecordCommandScope } from './contracts/game'
import { recordCommandScope } from './recordCommandScope.ts'

export function usePlayerNames(gameView: GameView, markDirty: () => void) {
  const drafts = reactive(new Map<number, string>())
  const draftScopes = new Map<number, RecordCommandScope | undefined>()
  const sessionKey = () => gameView.viewToken?.sessionId || gameView.gameId
  const error = ref('')
  let pending: Promise<void> | null = null

  function draft(seat: number, name: string) {
    drafts.set(seat, name)
    draftScopes.set(seat, recordCommandScope(gameView))
    markDirty()
  }

  async function flush(): Promise<void> {
    if (pending) {
      await pending
      return flush()
    }
    if (!drafts.size) return
    const gameId = sessionKey()
    const saving = async () => {
      for (const [seat, name] of [...drafts]) {
        if (sessionKey() !== gameId) return
        if (!window.studioAPI) throw new Error('Studio bridge unavailable')
        const result = await window.studioAPI.setPlayerName(seat, name, draftScopes.get(seat))
        if (sessionKey() !== gameId) return
        const names = [...(gameView.playerNames || ['', '', '', ''])]
        names[seat] = result.name
        gameView.playerNames = names
        if (drafts.get(seat) === name) { drafts.delete(seat); draftScopes.delete(seat) }
      }
    }
    pending = saving()
    try {
      await pending
      if (sessionKey() === gameId) error.value = ''
    } catch (failure) {
      if (sessionKey() === gameId) error.value = failure instanceof Error ? failure.message : String(failure)
      throw failure
    } finally {
      pending = null
    }
    if (drafts.size) await flush()
  }

  watch(sessionKey, () => {
    drafts.clear()
    draftScopes.clear()
    error.value = ''
  }, { flush: 'sync' })
  return { drafts, error, draft, flush, cancel: (seat: number) => { draftScopes.delete(seat); return drafts.delete(seat) } }
}
