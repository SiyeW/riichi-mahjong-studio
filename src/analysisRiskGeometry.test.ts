import assert from 'node:assert/strict'
import test from 'node:test'
import { analysisRiskGeometry } from './analysisRiskGeometry.ts'

test('risk geometry fills the width with nine tiles and one scale column', () => {
  const geometry = analysisRiskGeometry({
    availableWidth: 500,
    pixelRatio: 1,
    scaleSpace: 50,
    legendHeight: 16,
  })
  assert.equal(geometry.tileWidth, 50)
  assert.equal(geometry.mainRowWidth, 450)
  assert.equal(geometry.tileHeight, 65)
  assert.equal(geometry.barsWidth, 42)
  assert.equal(geometry.rowMinimumHeight, 132)
  assert.equal(geometry.gridMinimumHeight, 564)
})

test('risk geometry snaps every dimension to physical pixels', () => {
  const geometry = analysisRiskGeometry({
    availableWidth: 503.2,
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
    pixelRatio: 1,
    scaleSpace: 40,
    legendHeight: 20,
  })
  assert.equal(geometry.rowMinimumHeight, (geometry.tileHeight * 2) + geometry.chartGap)
  assert.equal(
    geometry.gridMinimumHeight,
    (geometry.rowMinimumHeight * 4) + (geometry.gridGap * 4) + 20,
  )
})
