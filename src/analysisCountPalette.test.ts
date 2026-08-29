import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCountColorScale, COUNT_EMPTY_COLOR } from './analysisCountPalette.ts'
import type { RgbColor } from './perceptualColor.ts'

const supportedSourceColors: RgbColor[] = [
  [44, 143, 197],
  [211, 154, 58],
  [76, 175, 80],
  [179, 77, 77],
  [77, 179, 179],
  [128, 77, 179],
  [33, 150, 243],
  [255, 235, 59],
  [129, 151, 143],
]

test('count scale keeps zero and two at their semantic anchors', () => {
  const base: RgbColor = [44, 143, 197]
  const scale = buildCountColorScale(base)
  assert.deepEqual(scale[0], COUNT_EMPTY_COLOR)
  assert.deepEqual(scale[2], base)
})

test('every RGB channel increases monotonically from two through four', () => {
  for (const base of supportedSourceColors) {
    const scale = buildCountColorScale(base)
    for (const channel of [0, 1, 2] as const) {
      assert.ok(scale[2][channel] <= scale[3][channel], `${base}: 2 -> 3, channel ${channel}`)
      assert.ok(scale[3][channel] <= scale[4][channel], `${base}: 3 -> 4, channel ${channel}`)
    }
  }
})

test('three and four occupy distinct parts of the light range', () => {
  for (const base of supportedSourceColors) {
    const scale = buildCountColorScale(base)
    const distance = (left: RgbColor, right: RgbColor) => Math.hypot(
      right[0] - left[0],
      right[1] - left[1],
      right[2] - left[2],
    )
    assert.ok(distance(scale[2], scale[3]) >= 20, `${base}: 2 -> 3`)
    assert.ok(distance(scale[3], scale[4]) >= 15, `${base}: 3 -> 4`)
  }
})
