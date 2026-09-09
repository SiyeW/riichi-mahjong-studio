import assert from 'node:assert/strict'
import test from 'node:test'
import { soundActionSignature, soundEventsForTransition, type SoundTransitionView } from './useSoundTransitions.ts'
import type { GameAction } from './contracts/game.ts'

function view(overrides: Partial<SoundTransitionView> = {}): SoundTransitionView {
  return {
    table: { lastAction: null } as TrainerGameView['table'],
    legalActions: [],
    pendingReview: null,
    ...overrides,
  }
}

const context = {
  blocked: false,
  isNewGame: false,
  mode: 'play' as const,
  transitionDirection: 'forward' as const,
}

test('sound action signatures distinguish the action fields used by playback', () => {
  const base = { type: 'dahai', actor: 0, pai: '5m', consumed: [] }
  assert.equal(soundActionSignature(base as never), soundActionSignature({ ...base } as never))
  assert.notEqual(soundActionSignature(base as never), soundActionSignature({ ...base, pai: '6m' } as never))
})

test('sound transitions report confirmations and new table actions in order', () => {
  const previous = view({
    table: { pendingDiscard: { actor: 0 }, lastAction: null } as TrainerGameView['table'],
  })
  const next = view({
    table: { pendingDiscard: null, lastAction: { type: 'pon', actor: 1 } } as TrainerGameView['table'],
  })
  assert.deepEqual(soundEventsForTransition(previous, next, context), ['action.confirmed', 'call.pon'])
})

test('sound transitions classify ron and tsumo from the action target', () => {
  const previous = view()
  const ron = view({ table: { lastAction: { type: 'hora', actor: 1, target: 2 } } as TrainerGameView['table'] })
  const tsumo = view({ table: { lastAction: { type: 'hora', actor: 1, target: 1 } } as TrainerGameView['table'] })
  assert.deepEqual(soundEventsForTransition(previous, ron, context), ['win.ron'])
  assert.deepEqual(soundEventsForTransition(previous, tsumo, context), ['win.tsumo'])
})

test('sound transitions report newly required choices, reviews, and results', () => {
  const previous = view()
  const next = view({
    table: { lastAction: null, resultInfo: { type: 'ryukyoku' } } as unknown as TrainerGameView['table'],
    legalActions: [{ type: 'pon' } as GameAction],
    pendingReview: {} as TrainerGameView['pendingReview'],
  })
  assert.deepEqual(soundEventsForTransition(previous, next, context), [
    'action.required',
    'review.required',
    'round.result',
  ])
})

test('sound transitions remain silent while blocked, booting a new game, or missing table state', () => {
  const previous = view()
  const next = view({ table: { lastAction: { type: 'dahai', actor: 0, pai: '1m' } } as TrainerGameView['table'] })
  assert.deepEqual(soundEventsForTransition(previous, next, { ...context, blocked: true }), [])
  assert.deepEqual(soundEventsForTransition(previous, next, { ...context, isNewGame: true }), [])
  assert.deepEqual(soundEventsForTransition({ ...previous, table: null }, next, context), [])
})
