import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bufferedVerticalRange,
  hitRegionIsVisible,
  pointIsVisible,
  rangeIsVisible,
} from './useVirtualizedTreeViewport.ts'

test('buffered viewport range clamps its upper boundary to the canvas', () => {
  assert.deepEqual(bufferedVerticalRange(40, 100, 60), {
    top: 0,
    bottom: 200,
  })
  assert.deepEqual(bufferedVerticalRange(200, -10, 40), {
    top: 160,
    bottom: 240,
  })
})

test('point and range visibility include items touching the viewport boundary', () => {
  const range = { top: 100, bottom: 200 }

  assert.equal(pointIsVisible({ y: 100 }, range), true)
  assert.equal(pointIsVisible({ y: 201 }, range), false)
  assert.equal(rangeIsVisible({ minY: 50, maxY: 100 }, range), true)
  assert.equal(rangeIsVisible({ minY: 201, maxY: 250 }, range), false)
})

test('hit regions remain visible while any vertical portion overlaps', () => {
  const range = { top: 100, bottom: 200 }

  assert.equal(hitRegionIsVisible({ y: 80, height: 20 }, range), true)
  assert.equal(hitRegionIsVisible({ y: 200, height: 20 }, range), true)
  assert.equal(hitRegionIsVisible({ y: 79, height: 20 }, range), false)
})
