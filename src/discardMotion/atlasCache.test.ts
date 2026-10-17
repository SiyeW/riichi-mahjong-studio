import assert from 'node:assert/strict'
import test from 'node:test'
import { createMotionAtlasCache } from './atlasCache.ts'

test('an exact atlas is reused without detaching or mutating the cached buffer', async () => {
  const cache = createMotionAtlasCache()
  let loads = 0
  const load = async () => { loads++; return new Uint8ClampedArray([1, 2, 3, 4]) }
  const first = await cache.read('pose', load)
  structuredClone(first.pixels, { transfer: [first.pixels.buffer] })
  const second = await cache.read('pose', load)
  assert.equal(second.hit, true)
  assert.deepEqual([...second.pixels], [1, 2, 3, 4])
  second.pixels[0] = 9
  assert.equal((await cache.read('pose', load)).pixels[0], 1)
  assert.equal(loads, 1)
})

test('byte budget includes key strings and evicts least recently used atlases', async () => {
  const cache = createMotionAtlasCache(12)
  const load = async () => new Uint8ClampedArray(4)
  await cache.read('a', load); await cache.read('b', load)
  await cache.read('a', load); await cache.read('c', load)
  assert.equal(cache.bytes, 12)
  assert.equal((await cache.read('a', load)).hit, true)
  assert.equal((await cache.read('b', load)).hit, false)
  assert.equal((await cache.read('oversized', load)).hit, false)
  assert.equal(cache.bytes, 12)
})

test('retired async preparation cannot repopulate a cleared cache', async () => {
  const cache = createMotionAtlasCache()
  let finish!: (pixels: Uint8ClampedArray) => void
  const read = cache.read('old', () => new Promise(resolve => { finish = resolve }))
  cache.clear(); finish(new Uint8ClampedArray(4)); await read
  assert.equal(cache.bytes, 0)
  const load = async () => new Uint8ClampedArray(4)
  assert.equal((await cache.read('new-theme', load)).hit, false)
  cache.clear(); assert.equal(cache.bytes, 0)
  const retired = cache.generation
  cache.clear()
  await cache.read('late-assets', load, retired)
  assert.equal(cache.bytes, 0)
})
