import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAutoAdvanceDelay } from './useAutoAdvance.ts'
import type { GameView } from './contracts/game.ts'

function state(overrides: Record<string, unknown> = {}) {
  return {
    controlledSeat: 0,
    defaultDelayMs: 500,
    legalActionCount: 0,
    mode: 'play' as const,
    pendingReview: false,
    prefetchReady: false,
    prefetchWaiting: false,
    readOnly: false,
    table: { phase: 'discard', currentActor: 1 } as GameView['table'],
    ...overrides,
  }
}

test('auto advance stops for non-play, read-only, review, and terminal states', () => {
  assert.equal(resolveAutoAdvanceDelay(state({ mode: 'research' })), null)
  assert.equal(resolveAutoAdvanceDelay(state({ readOnly: true })), null)
  assert.equal(resolveAutoAdvanceDelay(state({ pendingReview: true })), null)
  assert.equal(resolveAutoAdvanceDelay(state({ table: { phase: 'round_result' } as GameView['table'] })), null)
})

test('prefetch readiness takes priority while waiting blocks advancement', () => {
  assert.equal(resolveAutoAdvanceDelay(state({ prefetchReady: true, prefetchWaiting: true })), 500)
  assert.equal(resolveAutoAdvanceDelay(state({ prefetchWaiting: true })), null)
})

test('auto advance preserves immediate AI and controlled draw timing', () => {
  assert.equal(resolveAutoAdvanceDelay(state({ table: { autoAdvanceMode: 'ai_think' } as GameView['table'] })), 0)
  assert.equal(resolveAutoAdvanceDelay(state({ table: { phase: 'draw_or_discard', currentActor: 0 } as GameView['table'] })), 30)
  assert.equal(resolveAutoAdvanceDelay(state({ table: { riichiDiscardState: 'ankan_choice' } as GameView['table'] })), 6000)
})

test('legal choices block automatic progress except a completed prefetch', () => {
  assert.equal(resolveAutoAdvanceDelay(state({ legalActionCount: 1 })), null)
  assert.equal(resolveAutoAdvanceDelay(state({ legalActionCount: 1, prefetchReady: true })), 500)
  assert.equal(resolveAutoAdvanceDelay(state({
    legalActionCount: 1,
    table: { phase: 'reach_declaration' } as GameView['table'],
  })), null)
})

test('reaction windows respect the larger configured or engine delay', () => {
  assert.equal(resolveAutoAdvanceDelay(state({
    table: { phase: 'reaction', reactionWindow: { thinkingTimeS: 1.25 } } as GameView['table'],
  })), 1250)
  assert.equal(resolveAutoAdvanceDelay(state({
    defaultDelayMs: 1500,
    table: { phase: 'reaction', reactionWindow: { thinkingTimeS: 1.25 } } as GameView['table'],
  })), 1500)
})
