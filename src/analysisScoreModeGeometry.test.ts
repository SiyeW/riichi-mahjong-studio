import assert from 'node:assert/strict'
import test from 'node:test'
import { scoreModeGeometry } from './analysisScoreModeGeometry.ts'

test('score nominations use every candidate that genuinely fits', () => {
  assert.equal(scoreModeGeometry({
    availableWidth: 102,
    minimumItemWidth: 24,
    desiredGap: 2,
    maximumCount: 6,
    pixelRatio: 1,
  }).count, 4)
  assert.equal(scoreModeGeometry({
    availableWidth: 101,
    minimumItemWidth: 24,
    desiredGap: 2,
    maximumCount: 6,
    pixelRatio: 1,
  }).count, 3)
})

test('score nomination columns and gaps snap to physical pixels', () => {
  const ratio = 1.5
  const geometry = scoreModeGeometry({
    availableWidth: 137.4,
    minimumItemWidth: 25.2,
    desiredGap: 1.2,
    maximumCount: 8,
    pixelRatio: ratio,
  })
  assert.equal(Number.isInteger(geometry.gap * ratio), true)
  assert.equal(geometry.columns.every((width) => Number.isInteger(width * ratio)), true)
  const occupiedPhysicalWidth = (
    geometry.columns.reduce((sum, width) => sum + width, 0)
    + (geometry.gap * Math.max(0, geometry.count - 1))
  ) * ratio
  assert.equal(occupiedPhysicalWidth <= Math.floor(137.4 * ratio), true)
})
