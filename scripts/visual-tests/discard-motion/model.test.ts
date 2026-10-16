import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCssEasing } from '../../../src/uiMotion.ts'
import { motionSample, sampledTime, sweepOffsets, sweepSampleCount, updateInterval } from './model.ts'

const ease = parseCssEasing('cubic-bezier(0.33, 1, 0.68, 1)')!
test('sample-and-hold cadences use the same time and always reach the endpoint', () => {
  for (const every of [1, 2, 3]) {
    const interval = 1000 * every / 165
    assert.equal(sampledTime(interval * 1.1, 110, 165, every), interval)
    assert.equal(sampledTime(110, 110, 165, every), 110)
    assert.equal(sampledTime(-5, 110, 165, every), 0)
  }
})
test('full-interval exposure adapts to cadence instead of leaving a half-shutter gap', () => {
  for (const every of [1, 2, 3]) assert.equal(updateInterval(165, every), 1000 * every / 165)
  const slow = motionSample(30, 110, 400, updateInterval(165, 3), false, ease)
  const fast = motionSample(30, 110, 400, updateInterval(165, 1), false, ease)
  assert.ok(slow.blurLength > fast.blurLength)
  assert.equal(slow.previousProgress, ease((30 - 1000 * 3 / 165) / 110))
  assert.equal(updateInterval(0, 1), 0)
})
test('sweep samples span the whole interval with overlapping tile coverage', () => {
  for (const distance of [100, 400, 600]) for (const width of [24, 34, 80]) {
    const count = sweepSampleCount(distance, width)
    const offsets = sweepOffsets(distance, count)
    assert.equal(offsets[0], -distance)
    assert.equal(offsets.at(-1), 0)
    assert.ok(count <= 64)
    assert.ok(offsets.slice(1).every((value, index) => value - offsets[index]! <= width * 0.5 + 1e-9))
  }
})
test('coverage follows ease-out, is not shortened to a small fixed tail, and endpoints are sharp', () => {
  const sample = (time: number) => motionSample(time, 110, 400, 18, false, ease)
  assert.equal(sample(0).blurLength, 0)
  assert.equal(motionSample(110, 110, 400, 0, false, ease).blurLength, 0)
  assert.ok(sample(20).blurLength > sample(80).blurLength)
  assert.ok(Array.from({ length: 111 }, (_, time) => sample(time).blurLength).every(value => value >= 0 && value <= 400))
  assert.ok(sample(20).blurLength > 24)
  assert.equal(motionSample(30, 110, 400, 0, false, ease).blurLength, 0)
  assert.equal(motionSample(0, 0, 400, 20, false, ease).progress, 1)
  assert.equal(motionSample(110, 110, 400, 110, false, ease).blurLength, 400,
    'a missed whole flight still has a final exposure interval before the sharp static endpoint')
})
test('reverse uses identical motion with the opposite face/back handoff', () => {
  for (const time of [0, 30, 60, 110]) {
    const forward = motionSample(time, 110, 400, 4, false, ease)
    const reverse = motionSample(time, 110, 400, 4, true, ease)
    assert.equal(forward.progress, reverse.progress)
    assert.equal(forward.blurLength, reverse.blurLength)
    assert.ok(Math.abs(forward.backOpacity + reverse.backOpacity - 1) < 1e-12)
  }
})
