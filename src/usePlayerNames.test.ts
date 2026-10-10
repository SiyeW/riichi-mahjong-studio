import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, reactive } from 'vue'
import type { GameView } from './contracts/game.ts'
import { usePlayerNames } from './usePlayerNames.ts'

function fixture(save: (seat: number, name: string) => Promise<{ name: string }>) {
  const scope = effectScope()
  const view = reactive({ gameId: 'game', playerNames: ['A', 'B', 'C', 'D'] }) as GameView
  let dirty = 0
  Object.assign(globalThis, { window: { studioAPI: { setPlayerName: save } } })
  const names = scope.run(() => usePlayerNames(view, () => { dirty++ }))!
  return { view, names, scope, dirty: () => dirty }
}

test('player name edits keep seat identity and serially flush newer drafts', async () => {
  let resolve!: (value: { name: string }) => void
  const calls: Array<[number, string]> = []
  const f = fixture(async (seat, name) => {
    calls.push([seat, name])
    if (calls.length === 1) return new Promise(yes => { resolve = yes })
    return { name }
  })
  try {
    f.names.draft(2, 'First')
    const flushing = f.names.flush()
    f.names.draft(2, 'Newer')
    const concurrentFlush = f.names.flush()
    resolve({ name: 'First' })
    await Promise.all([flushing, concurrentFlush])
    assert.deepEqual(calls, [[2, 'First'], [2, 'Newer']])
    assert.deepEqual(f.view.playerNames, ['A', 'B', 'Newer', 'D'])
    assert.equal(f.names.drafts.size, 0)
    assert.equal(f.dirty(), 2)
  } finally { f.scope.stop() }
})

test('failed name writes retain the draft for retry', async () => {
  let fail = true
  const f = fixture(async (_seat, name) => {
    if (fail) throw new Error('save failed')
    return { name }
  })
  try {
    f.names.draft(0, 'Retry')
    await assert.rejects(f.names.flush(), /save failed/)
    assert.equal(f.names.drafts.get(0), 'Retry')
    assert.equal(f.view.playerNames?.[0], 'A')
    fail = false
    await f.names.flush()
    assert.equal(f.view.playerNames?.[0], 'Retry')
    assert.equal(f.names.error.value, '')
  } finally { f.scope.stop() }
})

test('late name replies cannot change a replacement record', async () => {
  let resolve!: (value: { name: string }) => void
  const f = fixture(() => new Promise(yes => { resolve = yes }))
  try {
    f.names.draft(0, 'Old record')
    const flushing = f.names.flush()
    f.view.gameId = 'replacement'
    f.view.playerNames = ['New', '', '', '']
    resolve({ name: 'Old record' })
    await flushing
    assert.deepEqual(f.view.playerNames, ['New', '', '', ''])
    assert.equal(f.names.drafts.size, 0)
  } finally { f.scope.stop() }
})
