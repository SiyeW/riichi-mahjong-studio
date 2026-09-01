import assert from 'node:assert/strict'
import test from 'node:test'
import { analysisRiskGeometry } from './analysisRiskGeometry.ts'

test('risk geometry fills the width with nine tiles and one scale column', () => {
  const geometry = analysisRiskGeometry({
    availableWidth: 500,
    availableHeight: 1000,
    pixelRatio: 1,
    scaleSpace: 50,
    legendHeight: 16,
  })
  assert.equal(geometry.tileWidth, 50)
  assert.equal(geometry.mainRowWidth, 450)
  assert.equal(geometry.tileHeight, 65)
  assert.equal(geometry.barsWidth, 42)
  assert.equal(geometry.barsHeight, 174)
  assert.equal(geometry.rowMinimumHeight, 132)
  assert.equal(geometry.gridMinimumHeight, 564)
  assert.equal(geometry.gridContentHeight, 1000)
})

test('risk geometry snaps every dimension to physical pixels', () => {
  const geometry = analysisRiskGeometry({
    availableWidth: 503.2,
    availableHeight: 700.4,
    pixelRatio: 1.5,
    scaleSpace: 39.2,
    legendHeight: 15.5,
  })
  for (const value of Object.values(geometry)) {
    assert.ok(Math.abs(value * 1.5 - Math.round(value * 1.5)) < 1e-9)
  }
})

test('risk rows reserve one tile height for bars before scrolling', () => {
  const geometry = analysisRiskGeometry({
    availableWidth: 320,
    availableHeight: 100,
    pixelRatio: 1,
    scaleSpace: 40,
    legendHeight: 20,
    minimumTileWidth: 20,
  })
  assert.equal(geometry.barsHeight, geometry.tileHeight)
  assert.equal(geometry.rowMinimumHeight, geometry.tileHeight + geometry.chartGap + geometry.barsHeight)
  assert.equal(
    geometry.gridMinimumHeight,
    (geometry.rowMinimumHeight * 4) + (geometry.gridGap * 4) + 20,
  )
})

test('risk bars expand into height that is no longer used to enlarge tiles', () => {
  const compact = analysisRiskGeometry({
    availableWidth: 500,
    availableHeight: 540,
    pixelRatio: 1,
    scaleSpace: 50,
    legendHeight: 16,
  })
  const roomy = analysisRiskGeometry({
    availableWidth: 500,
    availableHeight: 1000,
    pixelRatio: 1,
    scaleSpace: 50,
    legendHeight: 16,
  })
  assert.ok(compact.barsHeight < roomy.barsHeight)
  assert.ok(roomy.barsHeight > roomy.tileHeight)
  assert.equal(roomy.gridContentHeight, 1000)
})

test('risk tiles stop growing at the interface tile limit', () => {
  const geometry = analysisRiskGeometry({
    availableWidth: 2400,
    availableHeight: 2400,
    pixelRatio: 1,
    scaleSpace: 40,
    legendHeight: 20,
    minimumTileWidth: 20,
    maximumTileWidth: 48,
    rowCount: 4,
    longestRow: 9,
    laneCount: 3,
  })
  assert.equal(geometry.tileWidth, 48)
  assert.ok(geometry.barsHeight > geometry.tileHeight)
  assert.equal(geometry.gridContentHeight, 2400)
})
