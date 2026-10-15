import assert from 'node:assert/strict'
import test from 'node:test'
import { ARTWORK_CACHE_VERSION, artworkPngHeaderMatches, sufficientArtwork, type CachedTileArtwork } from './artworkCache.ts'

function entryWithHeader(width = 96, height = 128): CachedTileArtwork {
  const header = new ArrayBuffer(24)
  const view = new DataView(header)
  for (const [offset, value] of [[0, 0x89504e47], [4, 0x0d0a1a0a], [8, 13], [12, 0x49484452], [16, width], [20, height]]) view.setUint32(offset, value)
  return { id: '1m', sourceHash: 'hash', version: ARTWORK_CACHE_VERSION,
    pixelWidth: 96, pixelHeight: 128, blob: new Blob([header], { type: 'image/png' }) }
}

test('cached artwork reuses adequate coverage but rejects stale, oversized and malformed bodies', () => {
  const entry = entryWithHeader()
  assert.equal(sufficientArtwork(entry, 'hash', 80, 264), true)
  assert.equal(sufficientArtwork(entry, 'hash', 112, 264), false)
  assert.equal(sufficientArtwork(entry, 'changed', 80, 264), false)
  assert.equal(sufficientArtwork({ ...entry, version: 0 }, 'hash', 80, 264), false)
  assert.equal(sufficientArtwork({ ...entry, pixelHeight: 127 }, 'hash', 80, 264), false)
  assert.equal(sufficientArtwork({ ...entry, pixelWidth: 300 }, 'hash', 80, 264), false)
  assert.equal(sufficientArtwork({ ...entry, pixelWidth: 97 }, 'hash', 80, 264), false)
  assert.equal(sufficientArtwork({ ...entry, blob: new Blob() }, 'hash', 80, 264), false)
  assert.equal(sufficientArtwork(undefined, 'hash', 80, 264), false)
})

test('PNG dimensions and signature are checked before decoder allocation', async () => {
  assert.equal(await artworkPngHeaderMatches(entryWithHeader()), true)
  assert.equal(await artworkPngHeaderMatches(entryWithHeader(1_000_000, 1_000_000)), false)
  assert.equal(await artworkPngHeaderMatches(entryWithHeader(96, 129)), false)
  assert.equal(await artworkPngHeaderMatches({ ...entryWithHeader(), blob: new Blob(['bad']) }), false)
  const brokenSignature = new Uint8Array(await entryWithHeader().blob.arrayBuffer())
  brokenSignature[0] = 0
  assert.equal(await artworkPngHeaderMatches({ ...entryWithHeader(), blob: new Blob([brokenSignature]) }), false)
})
