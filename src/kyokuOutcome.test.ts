import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveKyokuOutcome } from './kyokuOutcome.ts'

const outcomes = [
  { type: 'draw', probability: 0.25 },
  { type: 'tsumo', winner: 0, probability: 0.15 },
  { type: 'ron', winners: [1], target: 0, probability: 0.20 },
  { type: 'ron', winners: [2], target: 1, probability: 0.10 },
  { type: 'ron', winners: [2, 3], target: 0, probability: 0.30 },
]

test('derives player totals and mutually exclusive details from final outcomes', () => {
  const result = resolveKyokuOutcome({ outcomes })

  assert.equal(result.drawProbability, 0.25)
  assert.deepEqual(result.players.map((player) => player.winProbability), [0.15, 0.20, 0.40, 0.30])
  assert.deepEqual(result.players.map((player) => player.dealInProbability), [0.50, 0.10, 0, 0])
  assert.deepEqual(result.players[0].dealInWinnerSets, [
    { winners: [1], probability: 0.4 },
    { winners: [2, 3], probability: 0.6 },
  ])
})

test('uses direct player totals without replacing outcome-derived hover details', () => {
  const result = resolveKyokuOutcome({
    drawProbability: 0.12,
    players: [0, 1, 2, 3].map((seat) => ({
      seat,
      winProbability: 0.4 + (seat * 0.01),
      dealInProbability: 0.1 + (seat * 0.01),
    })),
    outcomes,
  })

  assert.equal(result.drawProbability, 0.12)
  assert.equal(result.players[0].winProbability, 0.4)
  assert.equal(result.players[0].dealInProbability, 0.1)
  assert.deepEqual(result.players[0].dealInWinnerSets, [
    { winners: [1], probability: 0.4 },
    { winners: [2, 3], probability: 0.6 },
  ])
})

test('accepts a direct summary without detailed outcomes', () => {
  const result = resolveKyokuOutcome({
    drawProbability: 0.3,
    players: [0, 1, 2, 3].map((seat) => ({
      seat,
      winProbability: 0.2,
      dealInProbability: 0.1,
    })),
  })

  assert.equal(result.hasDetails, false)
  assert.equal(result.hasTotals, true)
  assert.equal(result.drawProbability, 0.3)
  assert.deepEqual(result.players[2].winTargets, [])
})

test('does not turn missing analysis into a horizontal-movement prediction', () => {
  const result = resolveKyokuOutcome({})
  assert.equal(result.hasTotals, false)
})
