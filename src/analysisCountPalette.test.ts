import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCountColorScale,
  COUNT_EMPTY_COLOR,
  countPaletteVariable,
  countSegmentColor,
  countSourcePalette,
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

test('count levels increase monotonically in perceptual lightness', () => {
  for (const base of supportedSourceColors) {
    const scale = buildCountColorScale(base)
    const lightness = scale.map((color) => rgbToOklab(color).l)
    for (let index = 1; index < lightness.length; index += 1) {
      assert.ok(lightness[index] > lightness[index - 1], `${base}: ${index - 1} -> ${index}`)
    }
  }
})

test('one divides the perceptual interval between empty and the source color', () => {
  for (const base of supportedSourceColors) {
    const scale = buildCountColorScale(base).map(rgbToOklab)
    const lowerDistance = Math.hypot(
      scale[1].l - scale[0].l,
      scale[1].a - scale[0].a,
      scale[1].b - scale[0].b,
    )
    const upperDistance = Math.hypot(
      scale[2].l - scale[1].l,
      scale[2].a - scale[1].a,
      scale[2].b - scale[1].b,
    )
    assert.ok(
      Math.abs(lowerDistance - upperDistance) < 0.005,
      `${base}: ${lowerDistance} / ${upperDistance}`,
    )
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
      assert.ok(distance >= 0.065, `${base}: ${index - 1} -> ${index}`)
    }
  }
})

test('three and four use the available highlight range', () => {
  const highlight = rgbToOklab([255, 255, 255])
  for (const base of supportedSourceColors) {
    const scale = buildCountColorScale(base).map(rgbToOklab)
    const distanceToHighlight = scale.map((color) => Math.hypot(
      color.l - highlight.l,
      color.a - highlight.a,
      color.b - highlight.b,
    ))
    assert.ok(distanceToHighlight[3] < distanceToHighlight[2], `${base}: 2 -> 3`)
    assert.ok(distanceToHighlight[4] < distanceToHighlight[3], `${base}: 3 -> 4`)
  }
})

test('source palettes resolve shared player variables and a derived wall color', () => {
  const variables: Record<string, string> = {
    '--ron-kamicha-color': '#2c8fc5',
    '--ron-toimen-color': '#d39a3a',
    '--ron-shimocha-color': '#4caf50',
  }
  const style = { getPropertyValue: (name: string) => variables[name] || '' }
  assert.equal(countSourcePalette('kamicha', style)[2], 'rgb(44 143 197)')
  assert.equal(countSourcePalette('wall', style).length, 5)
})

test('count color variables clamp distribution values to supported levels', () => {
  assert.equal(countPaletteVariable('wall', 2), '--analysis-count-wall-2')
  assert.equal(countSegmentColor('wall', -1), 'var(--analysis-count-wall-0)')
  assert.equal(countSegmentColor('wall', 9), 'var(--analysis-count-wall-4)')
})
