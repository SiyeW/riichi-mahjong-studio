import assert from 'node:assert/strict'
import test from 'node:test'
import type { TableState } from './contracts/game.ts'
import { buildRandomTileCountBaseline, randomBaselinePrediction, randomCountDistribution } from './randomTileCountBaseline.ts'

function tableFixture(overrides: Partial<TableState> = {}): TableState {
  return {
    bakaze: 'E', kyoku: 1, honba: 0, kyotaku: 0, dealer: 0,
    currentActor: 0, phase: 'discard', turn: 0, drawIndex: 53,
    wallRemaining: 69, doraIndicators: ['2p'], scores: [25000, 25000, 25000, 25000],
    hands: [
      ['1m', '2m', '3m', '4m', '5mr', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p', '5p'],
      Array.from({ length: 13 }, () => '1s'),
      Array.from({ length: 13 }, () => '2s'),
      Array.from({ length: 13 }, () => '3s'),
    ],
    rivers: [[], [], [], []], melds: [[], [], [], []],
    pendingDiscard: null, reactionWindow: null, lastAction: null,
    ...overrides,
  }
}

test('random count distribution is a normalized hypergeometric marginal', () => {
  const prediction = randomCountDistribution(4, 13, 121)
  assert.ok(Math.abs(prediction.distribution.reduce((sum, entry) => sum + entry.probability, 0) - 1) < 1e-12)
  assert.ok(Math.abs((prediction.scalarValue ?? 0) - (13 * 4 / 121)) < 1e-12)
})

test('random baseline uses only public tiles and concealed hand capacities', () => {
  const table = tableFixture()
  const baseline = buildRandomTileCountBaseline(table, 0)
  assert.ok(baseline)
  const oneSou = [
    randomBaselinePrediction(baseline, '1s', 1).scalarValue,
    randomBaselinePrediction(baseline, '1s', 2).scalarValue,
    randomBaselinePrediction(baseline, '1s', 3).scalarValue,
    randomBaselinePrediction(baseline, '1s', null).scalarValue,
  ]
  assert.ok(oneSou.every((value) => value !== null))
  assert.ok(Math.abs(oneSou.reduce<number>((sum, value) => sum + (value ?? 0), 0) - 4) < 1e-12)

  const redFive = randomBaselinePrediction(baseline, '5mr', null)
  assert.deepEqual(redFive.distribution.map((entry) => entry.probability), [1, 0])
})

test('called tiles already present in rivers are not counted twice', () => {
  const table = tableFixture({
    hands: [
      ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p'],
      Array.from({ length: 13 }, () => '2m'),
      Array.from({ length: 11 }, () => '3m'),
      Array.from({ length: 13 }, () => '4m'),
    ],
    rivers: [['F'], [], [], []],
    melds: [[], [], [{ type: 'pon', pai: 'F', consumed: ['F', 'F'] }], []],
    doraIndicators: ['C'],
  })
  const baseline = buildRandomTileCountBaseline(table, 0)
  assert.ok(baseline)
  const remainingGreenDragons = [
    randomBaselinePrediction(baseline, 'F', 1).scalarValue,
    randomBaselinePrediction(baseline, 'F', 2).scalarValue,
    randomBaselinePrediction(baseline, 'F', 3).scalarValue,
    randomBaselinePrediction(baseline, 'F', null).scalarValue,
  ].reduce<number>((sum, value) => sum + (value ?? 0), 0)
  assert.ok(Math.abs(remainingGreenDragons - 1) < 1e-12)
})

test('a discard becomes public before it is committed to the river', () => {
  const withoutPending = buildRandomTileCountBaseline(tableFixture(), 0)
  const withPending = buildRandomTileCountBaseline(tableFixture({
    pendingDiscard: { actor: 1, pai: '1s', tsumogiri: true, targetActor: 2 },
  }), 0)
  assert.ok(withoutPending && withPending)

  const before = randomBaselinePrediction(withoutPending, '1s', null)
  const after = randomBaselinePrediction(withPending, '1s', null)
  const sourceSeats: Array<number | null> = [1, 2, 3, null]
  const beforeRemaining = sourceSeats.reduce<number>((sum, seat) => (
    sum + (randomBaselinePrediction(withoutPending, '1s', seat).scalarValue ?? 0)
  ), 0)
  const afterRemaining = sourceSeats.reduce<number>((sum, seat) => (
    sum + (randomBaselinePrediction(withPending, '1s', seat).scalarValue ?? 0)
  ), 0)
  assert.ok((after.scalarValue ?? 0) < (before.scalarValue ?? 0))
  assert.ok(Math.abs(beforeRemaining - 4) < 1e-12)
  assert.ok(Math.abs(afterRemaining - 3) < 1e-12)
})
