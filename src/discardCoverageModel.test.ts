import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCssEasing } from './uiMotion.ts'
import { flightTranslationFrames, planDiscardCoverage } from './discardCoverageModel.ts'

const ease = parseCssEasing('cubic-bezier(0.33, 1, 0.68, 1)')!
test('coverage spans the previous-to-current interval, including its landing tail', () => {
  for (const exposure of [1000 / 165, 2000 / 165, 3000 / 165, 110]) {
    const plan = planDiscardCoverage(110, exposure, 400, 32, ease)!
    assert.ok(plan)
    assert.equal(plan.duration, 110 + exposure)
    assert.ok(plan.count <= 64 && Number.isInteger(Math.log2(plan.count)))
    assert.ok(plan.maximumSpan * 400 / (plan.count - 1) <= 8 + 1e-8)
    const clamp = (value: number) => Math.max(0, Math.min(1, value))
    for (let time = 0; time <= plan.duration; time++) {
      const now = ease(clamp(time / 110)), previous = ease(clamp((time - exposure) / 110))
      assert.ok((now - previous) * 400 / (plan.count - 1) <= 8 + .05)
      for (const weight of [0, .25, .5, .75, 1]) {
        assert.ok(Math.abs((1 - weight) * now + weight * previous - (now - weight * (now - previous))) < 1e-12)
      }
    }
  }
})
test('invalid or unbounded demand chooses the sharp fallback, never a shortened sweep', () => {
  for (const values of [[0, 6, 400, 32], [110, 0, 400, 32], [110, 6, NaN, 32],
    [110, 110, 10000, 2], [110, 6, 0, 32]]) {
    assert.equal(planDiscardCoverage(...values as [number, number, number, number], ease), null)
  }
})
test('the native source keeps its original movement duration/easing before the exposure hold', () => {
  const frames = flightTranslationFrames('translateX(400px)', 'translateX(0px)', 110, 128, 'ease-out')
  assert.equal(frames[1]!.offset! * 128, 110)
  assert.equal(frames[0]!.easing, 'ease-out')
  assert.deepEqual(flightTranslationFrames('a', 'b', 110, 110, 'ease-out'), [{ transform: 'a' }, { transform: 'b' }])
})
