import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ANALYSIS_TILE_ROWS,
  analysisCountSourceTiles,
  analysisCountTileRows,
  isRedFiveTile,
  tile34Index,
} from './analysisTiles.ts'

test('the shared tile rows contain every ordinary tile exactly once', () => {
  const tiles = ANALYSIS_TILE_ROWS.flat()
  assert.equal(tiles.length, 34)
  assert.equal(new Set(tiles).size, 34)
})

test('tile indexes normalize red fives and preserve honor indexes', () => {
  assert.equal(tile34Index('1m'), 0)
  assert.equal(tile34Index('5mr'), 4)
  assert.equal(tile34Index('9s'), 26)
  assert.equal(tile34Index('E'), 27)
  assert.equal(tile34Index('C'), 33)
})

test('count layouts add optional red fives as a separate source group', () => {
  assert.equal(analysisCountTileRows(false)[0].tiles.length, 9)
  assert.deepEqual(analysisCountTileRows(true)[0].tiles.slice(-2), ['9m', '5mr'])

  const sourceTiles = analysisCountSourceTiles(true)
  assert.equal(sourceTiles.length, 37)
  assert.equal(sourceTiles.at(-3)?.groupStart, true)
  assert.equal(sourceTiles.at(-2)?.groupStart, false)
  assert.equal(isRedFiveTile(sourceTiles.at(-1)?.tile || ''), true)
})
