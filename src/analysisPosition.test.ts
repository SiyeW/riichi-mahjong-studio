import assert from 'node:assert/strict'
import test from 'node:test'
import { decisionPositionKey, sameViewRequestContext, type ViewRequestContext } from './analysisPosition.ts'

test('decision cache keys isolate all four perspectives at the same node', () => {
  const keys = [0, 1, 2, 3].map(seat => decisionPositionKey('game', 'node', seat))
  assert.equal(new Set(keys).size, 4)
  assert.notEqual(keys[0], decisionPositionKey('other-game', 'node', 0))
  assert.notEqual(keys[0], decisionPositionKey('game', 'other-node', 0))
})

test('invalid decision positions cannot enter the cache', () => {
  for (const seat of [-1, 4, 0.5, NaN]) assert.equal(decisionPositionKey('game', 'node', seat), null)
  assert.equal(decisionPositionKey(null, 'node', 0), null)
  assert.equal(decisionPositionKey('game', null, 0), null)
})

test('navigation replies only belong to their original view and latest intent', () => {
  const original: ViewRequestContext = { gameId: 'game', seat: 0, mode: 'research', generation: 1, intent: 2 }
  assert.equal(sameViewRequestContext(original, { ...original }), true)
  for (const change of [
    { gameId: 'new-game' }, { gameId: null }, { seat: 1 }, { mode: 'play' },
    { generation: 2 }, { intent: 3 },
  ]) assert.equal(sameViewRequestContext(original, { ...original, ...change }), false)
})

test('switching away and back still invalidates the original request', () => {
  const original: ViewRequestContext = { gameId: 'game', seat: 0, mode: 'research', generation: 1, intent: 2 }
  assert.equal(sameViewRequestContext(original, { ...original, generation: 3 }), false)
})
