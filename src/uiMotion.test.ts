import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCssEasing, parseCssTimeMs } from './uiMotion.ts'

test('CSS motion durations retain millisecond and second units', () => {
  assert.equal(parseCssTimeMs('110ms'), 110)
  assert.equal(parseCssTimeMs('0.11s'), 110)
  assert.equal(parseCssTimeMs('invalid'), null)
})

test('the shared ease-out curve starts quickly and settles slowly', () => {
  const easing = parseCssEasing('cubic-bezier(0.33, 1, 0.68, 1)')
  assert.ok(easing)
  assert.equal(easing(0), 0)
  assert.equal(easing(1), 1)
  assert.ok(easing(0.25) > 0.5)
  assert.ok(easing(0.5) - easing(0.25) > easing(1) - easing(0.75))
})

test('invalid curves are rejected and linear progress remains linear', () => {
  assert.equal(parseCssEasing('cubic-bezier(1.2, 0, 0, 1)'), null)
  assert.equal(parseCssEasing('unknown'), null)
  assert.equal(parseCssEasing('linear')?.(0.4), 0.4)
})
