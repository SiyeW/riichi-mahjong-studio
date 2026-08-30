import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCountColorScale,
  buildWallCountColorScale,
  COUNT_EMPTY_COLOR,
} from './analysisCountPalette.ts'
import { rgbToOklab } from './perceptualColor.ts'
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

function hueDistance(first: number, second: number): number {
  return Math.abs(Math.atan2(Math.sin(first - second), Math.cos(first - second)))
}

test('count levels increase monotonically in perceptual lightness', () => {
  for (const base of supportedSourceColors) {
    const scale = buildCountColorScale(base)
    const lightness = scale.map((color) => rgbToOklab(color).l)
    for (let index = 1; index < lightness.length; index += 1) {
      assert.ok(lightness[index] > lightness[index - 1], `${base}: ${index - 1} -> ${index}`)
    }
  }
})

test('non-empty count levels preserve their source hue', () => {
  for (const base of supportedSourceColors) {
    const baseLab = rgbToOklab(base)
    const baseHue = Math.atan2(baseLab.b, baseLab.a)
    const scale = buildCountColorScale(base)
    for (const level of [1, 2, 3, 4]) {
      const color = rgbToOklab(scale[level])
      const colorHue = Math.atan2(color.b, color.a)
      assert.ok(hueDistance(colorHue, baseHue) < 0.03, `${base}: level ${level}`)
    }
  }
})

test('adjacent count levels remain perceptually distinct', () => {
  for (const base of supportedSourceColors) {
    const scale = buildCountColorScale(base).map(rgbToOklab)
    for (let index = 1; index < scale.length; index += 1) {
      const distance = Math.hypot(
        scale[index].l - scale[index - 1].l,
        scale[index].a - scale[index - 1].a,
        scale[index].b - scale[index - 1].b,
      )
      assert.ok(distance >= 0.06, `${base}: ${index - 1} -> ${index}`)
    }
  }
})

test('wall scale stays quieter while retaining the same anchors', () => {
  const base: RgbColor = [129, 151, 143]
  const playerScale = buildCountColorScale(base)
  const wallScale = buildWallCountColorScale(base)
  assert.deepEqual(wallScale[0], COUNT_EMPTY_COLOR)
  assert.deepEqual(wallScale[2], base)
  assert.ok(rgbToOklab(wallScale[4]).l < rgbToOklab(playerScale[4]).l)
})
