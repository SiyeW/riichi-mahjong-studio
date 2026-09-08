import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import { useGameplayActions } from './useGameplayActions.ts'

function fixture() {
  const status = { mode: 'play', controlledSeat: 0 } as TrainerStatusSnapshot
  const gameView = {
    table: { currentActor: 0 },
    legalActions: [{ id: 'discard', type: 'dahai', actor: 0, pai: '1m', label: '1m' }],
  } as TrainerGameView
  const applied: string[] = []
  const prefetchReady = ref(false)
  const session = useGameplayActions({
    gameView,
    status,
    readOnlyRecord: ref(false),
    prefetchReady,
    applyStatus: () => { applied.push('status') },
    applyGameView: () => { applied.push('view') },
    applyPlayPrefetchStatus: () => { applied.push('prefetch') },
    beginPlayPrefetchAdvance: () => { applied.push('begin') },
    scheduleAutoAdvance: () => { applied.push('schedule') },
  })
  return { applied, gameView, prefetchReady, session, status }
}

const response = {
  state: {} as TrainerStatusSnapshot,
  view: {} as TrainerGameView,
  playPrefetch: { ready: false, waiting: false },
}

function replaceWindow(value: Partial<Window>): () => void {
  const previous = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value })
  return () => Object.defineProperty(globalThis, 'window', { configurable: true, value: previous })
}

test('stale action responses cannot overwrite a changed gameplay context', async () => {
  const { applied, session } = fixture()
  let resolveRequest!: (value: TrainerEnvironmentResponse) => void
  const restoreWindow = replaceWindow({
    trainerAPI: { submitUserAction: () => new Promise((resolve) => { resolveRequest = resolve }) } as unknown as Window['trainerAPI'],
  })
  try {
    const request = session.submitAction({ id: 'pon', type: 'pon', actor: 0, label: 'pon' })
    session.invalidateGameplayResponses()
    resolveRequest(response as TrainerEnvironmentResponse)
    await request
    assert.deepEqual(applied, [])
  } finally {
    restoreWindow()
  }
})

test('concurrent action requests are serialized', async () => {
  const { session } = fixture()
  let resolveRequest!: (value: TrainerEnvironmentResponse) => void
  let requests = 0
  const restoreWindow = replaceWindow({
    trainerAPI: {
      submitUserAction: () => {
        requests += 1
        return new Promise((resolve) => { resolveRequest = resolve })
      },
    } as unknown as Window['trainerAPI'],
  })
  try {
    const first = session.submitAction({ id: 'pon', type: 'pon', actor: 0, label: 'pon' })
    await session.submitAction({ id: 'chi', type: 'chi', actor: 0, label: 'chi' })
    assert.equal(requests, 1)
    resolveRequest(response as TrainerEnvironmentResponse)
    await first
  } finally {
    restoreWindow()
  }
})

test('uncommitted prefetch advances status without replacing the view', async () => {
  const { applied, session } = fixture()
  const restoreWindow = replaceWindow({
    trainerAPI: {
      advanceGame: async () => ({ ...response, playPrefetch: { committed: false, ready: false, waiting: true } }),
    } as unknown as Window['trainerAPI'],
  })
  try {
    await session.advanceGame()
    assert.deepEqual(applied, ['begin', 'status', 'prefetch'])
  } finally {
    restoreWindow()
  }
})
