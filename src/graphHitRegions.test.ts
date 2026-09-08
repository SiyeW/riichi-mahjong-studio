import assert from 'node:assert/strict'
import test from 'node:test'

import { buildGraphHitRegions } from './graphHitRegions.ts'

test('graph hit regions sort rows and divide each row at the next dot edge', () => {
  const dots = [
    { id: 'right', x: 40, y: 30, radius: 4 },
    { id: 'next-row', x: 12, y: 50, radius: 3 },
    { id: 'left', x: 10, y: 30, radius: 2 },
  ]

  assert.deepEqual(buildGraphHitRegions(dots, 20, (dot) => dot.radius), [
    {
      dot: dots[2],
      x: 0,
      y: 20,
      width: 36,
      height: 20,
    },
    {
      dot: dots[0],
      x: 36,
      y: 20,
      width: '100%',
      height: 20,
    },
    {
      dot: dots[1],
      x: 0,
      y: 40,
      width: '100%',
      height: 20,
    },
  ])
})

test('graph hit regions clamp rows and overlapping boundaries to zero width', () => {
  const dots = [
    { id: 'wide', x: 2, y: 3, radius: 10 },
    { id: 'covered', x: 5, y: 3, radius: 10 },
  ]

  const regions = buildGraphHitRegions(dots, 10, (dot) => dot.radius)
  assert.equal(regions[0].y, 0)
  assert.equal(regions[0].width, 0)
  assert.equal(regions[1].x, 0)
})
