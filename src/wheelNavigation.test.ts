import assert from 'node:assert/strict'
import test from 'node:test'
import { createWheelStepAccumulator } from './wheelNavigation.ts'

test('coalesced native wheel ticks and OS pixel settings retain movement', () => {
  const wheel = createWheelStepAccumulator()
  for (const delta of [30, 100, 200]) {
    assert.equal(wheel.consume({ deltaY: delta, deltaMode: 0, isTrusted: true, wheelDeltaY: -120 }), 1)
    assert.equal(wheel.consume({ deltaY: -2 * delta, deltaMode: 0, isTrusted: true, wheelDeltaY: 240 }), -2)
  }
})

test('fractional high-resolution input accumulates and reverses without loss', () => {
  const wheel = createWheelStepAccumulator()
  const input = (delta: number) => wheel.consume({ deltaY: delta, deltaMode: 0, isTrusted: true, wheelDeltaY: -delta * 1.2 })
  assert.deepEqual([input(25), input(25), input(25), input(25), input(200), input(-300)], [0, 0, 0, 1, 2, -3])
  assert.equal(input(50), 0)
  assert.equal(input(-50), 0)
  assert.equal(input(100), 1)
  assert.equal(input(-50), 0)
})

test('standard pixel/line/page units and synthetic legacy fields are explicit', () => {
  const wheel = createWheelStepAccumulator()
  assert.equal(wheel.consume({ deltaY: 200, deltaMode: 0, wheelDeltaY: 200, isTrusted: false }), 2)
  assert.equal(wheel.consume({ deltaY: -6, deltaMode: 1 }), -2)
  assert.equal(wheel.consume({ deltaY: 2, deltaMode: 2 }), 2)
  assert.equal(wheel.consume({ deltaY: -200, deltaMode: 0, isTrusted: true, wheelDeltaY: -240 }), -2)
})

test('reset retires fractional movement; pinch and invalid units do not navigate', () => {
  const wheel = createWheelStepAccumulator()
  assert.equal(wheel.consume({ deltaY: 50, deltaMode: 0 }), 0)
  wheel.reset()
  assert.equal(wheel.consume({ deltaY: 50, deltaMode: 0 }), 0)
  assert.equal(wheel.consume({ deltaY: Infinity, deltaMode: 0 }), 0)
  assert.equal(wheel.consume({ deltaY: 100, deltaMode: 3 }), 0)
  assert.equal(wheel.consume({ deltaY: 100, deltaMode: 0, ctrlKey: true }), 0)
})
