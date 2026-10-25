import assert from 'node:assert/strict'
import test from 'node:test'
import { createCanvasPaintSnapshot } from './canvasPaintSnapshot.ts'

test('normal drawing does not build diagnostic strings; reads memoize only the last submitted state', () => {
  const canvas = {} as HTMLCanvasElement & { signature?: string }
  let formats = 0
  const snapshot = createCanvasPaintSnapshot<number[]>(canvas, 'signature', values => { formats++; return values.join(',') })
  assert.equal(canvas.signature, undefined)
  for (let frame = 0; frame < 100; frame++) snapshot.publish([frame, frame + 1])
  assert.equal(formats, 0)
  assert.equal(canvas.signature, '99,100')
  assert.equal(canvas.signature, '99,100')
  assert.equal(formats, 1)
  snapshot.publish([200])
  assert.equal(formats, 1)
  assert.equal(canvas.signature, '200')
  assert.equal(formats, 2)
  assert.ok(Object.keys(canvas).includes('signature'), 'existing probes can discover the snapshot')
  snapshot.dispose()
  snapshot.publish([300])
  assert.equal(canvas.signature, undefined)
  assert.equal(formats, 2)
})

test('late cleanup from an old drawing owner cannot delete the replacement snapshot', () => {
  const canvas = {} as HTMLCanvasElement & { signature?: string }
  const old = createCanvasPaintSnapshot<number>(canvas, 'signature', String)
  const next = createCanvasPaintSnapshot<number>(canvas, 'signature', String)
  next.publish(2)
  old.dispose()
  assert.equal(canvas.signature, '2')
  next.dispose()
  assert.equal(canvas.signature, undefined)
})
