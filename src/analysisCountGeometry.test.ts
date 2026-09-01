import assert from 'node:assert/strict'
import test from 'node:test'
import { groupedCountGeometry } from './analysisCountGeometry.ts'

test('grouped count tiles are constrained by width in a tall panel', () => {
  const geometry = groupedCountGeometry({
    availableWidth: 500,
    availableHeight: 1000,
    pixelRatio: 1,
    toggleHeight: 30,
    legendHeight: 48,
    minimumTileWidth: 20,
    tileGap: 6,
  })
  assert.equal(geometry.tileWidth, 50)
  assert.equal(geometry.mainRowWidth, 498)
})

test('grouped count tiles shrink in a wide but short panel', () => {
  const tall = groupedCountGeometry({
    availableWidth: 700,
    availableHeight: 1000,
    pixelRatio: 1,
    toggleHeight: 30,
    legendHeight: 48,
    minimumTileWidth: 20,
    tileGap: 6,
  })
  const short = groupedCountGeometry({
    availableWidth: 700,
    availableHeight: 430,
    pixelRatio: 1,
    toggleHeight: 30,
    legendHeight: 48,
    minimumTileWidth: 20,
    tileGap: 6,
  })
  assert.ok(short.tileWidth < tall.tileWidth)
  assert.equal(short.barMinimumHeight, short.tileHeight)
  assert.ok(short.gridMinimumHeight <= 430)
})

test('grouped count geometry keeps a readable lower bound and then scrolls', () => {
  const geometry = groupedCountGeometry({
    availableWidth: 700,
    availableHeight: 100,
    pixelRatio: 1.5,
    toggleHeight: 30,
    legendHeight: 48,
    minimumTileWidth: 20,
    tileGap: 6,
  })
  assert.equal(geometry.tileWidth, 20)
  assert.ok(geometry.gridMinimumHeight > 100)
  for (const value of Object.values(geometry)) {
    assert.ok(Math.abs(value * 1.5 - Math.round(value * 1.5)) < 1e-9)
  }
})

test('grouped count tiles stop growing at the interface tile limit', () => {
  const geometry = groupedCountGeometry({
    availableWidth: 2400,
    availableHeight: 2400,
    pixelRatio: 1,
    toggleHeight: 30,
    legendHeight: 20,
    minimumTileWidth: 16,
    maximumTileWidth: 48,
    rowCount: 4,
    longestRow: 9,
    laneCount: 4,
    tileGap: 6,
  })
  assert.equal(geometry.tileWidth, 48)
})
