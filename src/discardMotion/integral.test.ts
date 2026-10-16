import assert from 'node:assert/strict'
import test from 'node:test'
import { opacityAt, rowIntegrals } from './integral.ts'

test('row integrals retain premultiplied color and reset at every row', () => {
  const pixels = new Uint8ClampedArray([255,0,0,128, 0,255,0,255, 0,0,255,0, 255,255,255,255])
  const p = rowIntegrals(pixels, 2, 2)
  assert.deepEqual([...p.slice(0, 4)], [0,0,0,0])
  assert.ok(Math.abs(p[4]! - 128/255) < 1e-7)
  assert.ok(Math.abs(p[11]! - (1+128/255)) < 1e-7)
  assert.deepEqual([...p.slice(12, 20)], [0,0,0,0,0,0,0,0])
  assert.deepEqual([...p.slice(20, 24)], [1,1,1,1])
  assert.throws(() => rowIntegrals(pixels, 1, 1))
})
test('crossfade product represents the source-over occlusion term', () => {
  const a = new Uint8ClampedArray([255,100,0,128]), b = new Uint8ClampedArray([0,0,0,64])
  const product = rowIntegrals(a, 1, 1, b)
  assert.ok(Math.abs(product[4]! - 128*64/255**2) < 1e-7)
  assert.ok(Math.abs(product[5]! - 100*128*64/255**3) < 1e-7)
})
test('opacity follows the existing native hold/fade/hold stops', () => {
  const stops = [{offset:0,value:1},{offset:.2,value:1},{offset:.75,value:0},{offset:1,value:0}]
  assert.equal(opacityAt(stops, .1), 1)
  assert.ok(Math.abs(opacityAt(stops, .475) - .5) < 1e-12)
  assert.equal(opacityAt(stops, 1), 0)
})
