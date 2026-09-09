import test from 'node:test'
import assert from 'node:assert/strict'
import { useMahjongPresentationLabels } from './useMahjongPresentationLabels.ts'
import type { GameAction, GameView } from './contracts/game.ts'
import type { StudioStatus } from './contracts/runtime.ts'

function translate(key: string, params?: Record<string, string | number>): string {
  if (!params) return key
  return `${key}:${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')}`
}

test('mahjong presentation labels follow the live viewpoint and dealer', () => {
  const status = { controlledSeat: 1 } as StudioStatus
  const gameView = { table: { dealer: 2, phase: 'playing', currentActor: 3 } } as GameView
  const labels = useMahjongPresentationLabels({ gameView, status, t: translate })

  assert.equal(labels.relativeSeatLabel(1), 'seat.self')
  assert.equal(labels.relativeSeatLabel(0), 'seat.kamicha')
  assert.equal(labels.seatWindLabel(2), 'wind.east')
  assert.equal(labels.isCurrentActorSeat(3), true)

  status.controlledSeat = 2
  gameView.table!.dealer = 3
  assert.equal(labels.relativeSeatLabel(1), 'seat.kamicha')
  assert.equal(labels.seatWindLabel(3), 'wind.east')
})

test('mahjong presentation labels keep action and draw conventions', () => {
  const labels = useMahjongPresentationLabels({
    gameView: { table: null } as GameView,
    status: { controlledSeat: 0 } as StudioStatus,
    t: translate,
  })

  assert.equal(labels.reactionTypeLabel('pon'), 'action.pon')
  assert.equal(labels.ryukyokuActionLabel({ reason: 'suufon_renda' }), 'draw.suufon')
  assert.equal(labels.ryukyokuActionLabel({ reasonLabel: '荒牌流局' }), 'draw.exhaustive')
  assert.equal(labels.specialActionLabel({ type: 'hora', variant: 'tsumo' } as GameAction), 'action.tsumo')
})
