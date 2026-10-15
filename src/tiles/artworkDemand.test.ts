import assert from 'node:assert/strict'
import test from 'node:test'
import { fittedTableZoom, tableTileWidth } from '../tableGeometry.ts'
import { ARTWORK_GENERATION_BYTES, ARTWORK_SIZE_STEP, artworkGenerationBytes, artworkPixelWidth, artworkWidthFitsBudget, maximumArtworkPixelWidth } from './artworkDemand.ts'

test('prewarm shares the real table fit and scales physical pixels exactly once', () => {
  const input = { screenWidth: 2560, screenHeight: 1392, windowWidth: 1200, windowHeight: 800, pixelRatio: 1, uiTileWidth: 42 }
  const expected = Math.ceil(tableTileWidth(fittedTableZoom(2560, 1392)) / ARTWORK_SIZE_STEP) * ARTWORK_SIZE_STEP
  assert.equal(artworkPixelWidth(input), expected)
  assert.equal(artworkPixelWidth({ ...input, pixelRatio: 2 }), Math.ceil(tableTileWidth(fittedTableZoom(2560, 1392)) * 2 / ARTWORK_SIZE_STEP) * ARTWORK_SIZE_STEP)
  assert.equal(artworkPixelWidth({ ...input, uiTileWidth: 150 }), 168)
  assert.ok(artworkPixelWidth({ ...input, windowWidth: 5000, windowHeight: 3000 }) > expected)
})

test('known-face decoded generations stay bounded including transient handoff', () => {
  const maximum = maximumArtworkPixelWidth(40)
  assert.ok(artworkGenerationBytes(maximum, 40) <= ARTWORK_GENERATION_BYTES)
  assert.ok(!artworkWidthFitsBudget(maximum + ARTWORK_SIZE_STEP, 40))
  for (const width of [0, -1, NaN, Infinity, 32.5]) assert.equal(artworkWidthFitsBudget(width, 40), false)
  assert.equal(maximumArtworkPixelWidth(0), 0)
  assert.equal(artworkWidthFitsBudget(96, 0), false)
})
