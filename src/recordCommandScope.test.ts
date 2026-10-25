import assert from 'node:assert/strict'
import test from 'node:test'
import type { GameView } from './contracts/game.ts'
import { recordCommandScope } from './recordCommandScope.ts'

test('authored scope is detached and excludes unrelated analysis epochs', () => {
  const view = { viewToken: { sessionId: 'record', nodeId: 'n_1', seat: 1, mode: 'play', intent: 3,
    decisionEpoch: 7, opponentEpoch: 9, visibleHands: true, sequence: 10, gameId: 'game' } } as GameView
  const scope = recordCommandScope(view)
  view.viewToken!.intent = 4
  view.viewToken!.nodeId = 'n_2'
  assert.deepEqual(scope, { sessionId: 'record', nodeId: 'n_1', seat: 1, mode: 'play', intent: 3 })
})
