import assert from 'node:assert/strict'
import test from 'node:test'
import { distributionBarGeometry } from './distributionBarGeometry.ts'

test('distributions fill their budget with balanced boundaries without overflow', () => {
  for (const count of [0, 1, 8, 31, 54]) for (let width = 20; width <= 400; width += 7) for (const gap of [1, 2, 3]) {
    const before = Array.from({ length: count }, (_, i) => i > 0 && i % 7 === 0)
    const result = distributionBarGeometry(width + .63, before, gap)
    const widths = result.bars.map(bar => bar.right - bar.left)
    assert.ok(result.bars.every(bar => bar.right > bar.left))
    if (!result.dense) {
      assert.ok(result.bars.every(bar => Number.isInteger(bar.left) && Number.isInteger(bar.right)))
      assert.ok(Math.max(...widths) - Math.min(...widths) <= 1)
      assert.ok(result.gaps.every(item => item.right - item.left === gap))
    }
    assert.ok(result.bars.every(bar => result.gaps.every(item => bar.right <= item.left + 1e-9 || bar.left >= item.right - 1e-9)))
    assert.ok(result.bars.every(bar => bar.left >= 0 && bar.right <= result.contentWidth + 1e-9))
    if (count) {
      assert.equal(result.bars[0]!.left, 0)
      assert.ok(Math.abs(result.contentWidth - result.bars.at(-1)!.right) < 1e-9)
    }
  }
})
