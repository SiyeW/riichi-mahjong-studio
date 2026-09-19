import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isPossibleRiichiHandValue,
  riichiBasePoints,
  riichiSettlementValues,
} from './riichiScoring.ts'

test('four-han 30-fu uses the established non-kiriage settlements', () => {
  assert.equal(riichiBasePoints(4, 30), 1920)
  assert.deepEqual(riichiSettlementValues(1920), {
    nonDealerRon: 7700,
    dealerRon: 11600,
    nonDealerTsumo: 7900,
    dealerTsumo: 11700,
  })
})

test('possible hand values distinguish dealer and non-dealer settlements', () => {
  assert.equal(isPossibleRiichiHandValue(1000, true), false)
  assert.equal(isPossibleRiichiHandValue(1000, false), true)
  assert.equal(isPossibleRiichiHandValue(11600, true), true)
  assert.equal(isPossibleRiichiHandValue(11700, true), true)
  assert.equal(isPossibleRiichiHandValue(11600, false), false)
  assert.equal(isPossibleRiichiHandValue(11700, false), false)
  assert.equal(isPossibleRiichiHandValue(12000, true), true)
  assert.equal(isPossibleRiichiHandValue(12000, false), true)
})

test('stacked yakuman values remain possible without a fixed multiplier ceiling', () => {
  assert.equal(isPossibleRiichiHandValue(48000 * 7, true), true)
  assert.equal(isPossibleRiichiHandValue(32000 * 7, false), true)
  assert.equal(isPossibleRiichiHandValue(48001, true), false)
})
