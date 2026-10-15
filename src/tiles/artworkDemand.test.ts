import assert from 'node:assert/strict'
import test from 'node:test'
import { fittedTableZoom, tableTileWidth } from '../tableGeometry.ts'
import { ARTWORK_GENERATION_BYTES, artworkGenerationBytes, artworkPixelWidth, artworkWidthFitsBudget, maximumArtworkPixelWidth } from './artworkDemand.ts'
import { ARTWORK_CACHE_VERSION, sufficientArtwork, type CachedTileArtwork } from './artworkCache.ts'

test('prewarm shares the real table fit and scales physical pixels exactly once', () => {
  const input = { screenWidth: 2560, screenHeight: 1392, windowWidth: 1200, windowHeight: 800, pixelRatio: 1, uiTileWidth: 42 }
  const expected = Math.ceil(tableTileWidth(fittedTableZoom(2560, 1392)) / 16) * 16
  assert.equal(artworkPixelWidth(input), expected)
  assert.equal(artworkPixelWidth({ ...input, pixelRatio: 2 }), Math.ceil(tableTileWidth(fittedTableZoom(2560, 1392)) * 2 / 16) * 16)
  assert.equal(artworkPixelWidth({ ...input, uiTileWidth: 150 }), 160)
  assert.ok(artworkPixelWidth({ ...input, windowWidth: 5000, windowHeight: 3000 }) > expected)
})

test('known-face decoded generations stay bounded including transient handoff', () => {
  const maximum = maximumArtworkPixelWidth(40)
  assert.ok(artworkGenerationBytes(maximum, 40) <= ARTWORK_GENERATION_BYTES)
  assert.ok(!artworkWidthFitsBudget(maximum + 16, 40))
  for (const width of [0, -1, NaN, Infinity, 32.5]) assert.equal(artworkWidthFitsBudget(width, 40), false)
  assert.equal(maximumArtworkPixelWidth(0), 0)
  assert.equal(artworkWidthFitsBudget(96, 0), false)
})

test('cached artwork reuses adequate coverage but rejects stale, oversized and malformed bodies', () => {
  const entry: CachedTileArtwork = { id: '1m', sourceHash: 'hash', version: ARTWORK_CACHE_VERSION,
    pixelWidth: 96, pixelHeight: 128, blob: new Blob(['<svg/>'], { type: 'image/svg+xml' }) }
  assert.equal(sufficientArtwork(entry, 'hash', 80, 272), true)
  assert.equal(sufficientArtwork(entry, 'hash', 112, 272), false)
  assert.equal(sufficientArtwork(entry, 'changed', 80, 272), false)
  assert.equal(sufficientArtwork({ ...entry, version: 0 }, 'hash', 80, 272), false)
  assert.equal(sufficientArtwork({ ...entry, pixelHeight: 127 }, 'hash', 80, 272), false)
  assert.equal(sufficientArtwork({ ...entry, pixelWidth: 300 }, 'hash', 80, 272), false)
  assert.equal(sufficientArtwork({ ...entry, blob: new Blob() }, 'hash', 80, 272), false)
  assert.equal(sufficientArtwork(undefined, 'hash', 80, 272), false)
})
