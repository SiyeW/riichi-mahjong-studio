import assert from 'node:assert/strict'
import test from 'node:test'
import { distributionBarGeometry } from './distributionBarGeometry.ts'

test('dense distributions allocate equal physical bars and separate uniform gaps', () => {
  for (const count of [0, 1, 8, 31, 54]) for (let width = 20; width <= 400; width += 7) for (const gap of [1, 2, 3]) {
    const before = Array.from({ length: count }, (_, i) => i > 0 && i % 7 === 0)
    const result = distributionBarGeometry(width + .63, before, gap)
    assert.ok(result.bars.every(bar => Number.isInteger(bar.left) && bar.right - bar.left === result.barWidth))
    assert.ok(result.gaps.every(item => item.right - item.left === gap))
    assert.ok(result.bars.every(bar => result.gaps.every(item => bar.right <= item.left || bar.left >= item.right)))
    assert.ok(result.bars.every(bar => bar.left >= 0 && bar.right <= result.contentWidth))
    if (count) {
      assert.ok(result.barWidth >= 1)
      assert.ok(Math.abs(result.padding - (result.contentWidth - result.bars.at(-1)!.right)) <= 1)
    }
  }
})
