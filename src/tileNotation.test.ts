import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeTileFamily, toRedFiveDisplayTile } from './tileNotation.ts'

test('tile family normalization accepts engine and display red-five notation', () => {
  assert.equal(normalizeTileFamily('5mr'), '5m')
  assert.equal(normalizeTileFamily('5pr'), '5p')
  assert.equal(normalizeTileFamily('0s'), '5s')
  assert.equal(normalizeTileFamily('7z'), '7z')
  assert.equal(normalizeTileFamily(null), '')
})

test('red-five display notation is derived only for suited five families', () => {
  assert.equal(toRedFiveDisplayTile('5m'), '0m')
  assert.equal(toRedFiveDisplayTile('5pr'), '0p')
  assert.equal(toRedFiveDisplayTile('4s'), '4s')
  assert.equal(toRedFiveDisplayTile('P'), 'P')
})
