import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PERCEPTUAL_SURFACE_TUNING,
  PERCEPTUAL_COLOR_CALIBRATION_BACKGROUND,
  perceptualSurfaceVariables,
  type PerceptualColorPalette,
} from './perceptualSurface.ts'
import { parseCssColor, rgbToOklab } from './perceptualColor.ts'

const palette: PerceptualColorPalette = {
  decisionRecommendation: [26, 147, 26],
  kamicha: [44, 143, 197],
  toimen: [211, 154, 58],
  shimocha: [76, 175, 80],
  selfDealIn: [201, 85, 77],
}

test('calibration surface reproduces canonical analysis colors', () => {
  const variables = perceptualSurfaceVariables(palette, PERCEPTUAL_COLOR_CALIBRATION_BACKGROUND)
  assert.equal(variables['--ron-kamicha-color'], 'rgb(44 143 197)')
  assert.equal(variables['--ron-toimen-color'], 'rgb(211 154 58)')
  assert.equal(variables['--ron-shimocha-color'], 'rgb(76 175 80)')
  assert.equal(variables['--analysis-self-deal-in-color'], 'rgb(201 85 77)')
})

test('every semantic color uses the tuned surface compensation', () => {
  const variables = perceptualSurfaceVariables(palette, [9, 72, 85])
  assert.equal(variables['--ron-kamicha-color'], 'rgb(24 130 183)')
  assert.equal(variables['--ron-toimen-color'], 'rgb(197 141 41)')
  assert.equal(variables['--ron-shimocha-color'], 'rgb(61 161 67)')
  assert.equal(variables['--analysis-self-deal-in-color'], 'rgb(186 72 65)')
  assert.equal(variables['--analysis-draw-color'], variables['--ron-kamicha-color'])
  assert.equal(variables['--analysis-self-win-color'], variables['--ron-shimocha-color'])
  assert.equal(variables['--analysis-horizontal-color'], variables['--ron-toimen-color'])

  const adjustedGreen = parseCssColor(variables['--ron-shimocha-color'], palette.shimocha)
  assert.ok(rgbToOklab(adjustedGreen).l < rgbToOklab(palette.shimocha).l)
})

test('neutral anchors remain fixed after surface translation', () => {
  const variables = perceptualSurfaceVariables(palette, [9, 72, 85])
  assert.equal(variables['--analysis-rank-1-color'], 'rgb(235 235 235)')
  assert.equal(variables['--analysis-rank-4-color'], variables['--ron-kamicha-color'])
})

test('zero compensation leaves canonical colors unchanged on another surface', () => {
  const variables = perceptualSurfaceVariables(palette, [9, 72, 85], {
    lightnessCompensation: 0,
    chromaticCompensation: 0,
    surfaceChromaGain: 0,
  })
  assert.equal(variables['--ron-kamicha-color'], 'rgb(44 143 197)')
  assert.equal(variables['--ron-toimen-color'], 'rgb(211 154 58)')
  assert.equal(variables['--ron-shimocha-color'], 'rgb(76 175 80)')
})

test('negative compensation reproduces the former same-direction adjustment', () => {
  const variables = perceptualSurfaceVariables(palette, [9, 72, 85], {
    lightnessCompensation: -1,
    chromaticCompensation: -1,
    surfaceChromaGain: 0,
  })
  assert.equal(variables['--ron-kamicha-color'], 'rgb(50 160 220)')
  assert.equal(variables['--ron-toimen-color'], 'rgb(224 173 87)')
  assert.equal(variables['--ron-shimocha-color'], 'rgb(82 194 104)')
})

test('surface chroma gain increases chroma away from the calibration surface', () => {
  const baselineVariables = perceptualSurfaceVariables(
    palette,
    [9, 72, 85],
    DEFAULT_PERCEPTUAL_SURFACE_TUNING,
  )
  const boostedVariables = perceptualSurfaceVariables(palette, [9, 72, 85], {
    ...DEFAULT_PERCEPTUAL_SURFACE_TUNING,
    surfaceChromaGain: 2,
  })
  const baseline = rgbToOklab(parseCssColor(baselineVariables['--ron-kamicha-color'], palette.kamicha))
  const boosted = rgbToOklab(parseCssColor(boostedVariables['--ron-kamicha-color'], palette.kamicha))
  assert.ok(Math.hypot(boosted.a, boosted.b) > Math.hypot(baseline.a, baseline.b))
})

test('surface chroma gain does not alter the calibration colors', () => {
  const variables = perceptualSurfaceVariables(
    palette,
    PERCEPTUAL_COLOR_CALIBRATION_BACKGROUND,
    {
      ...DEFAULT_PERCEPTUAL_SURFACE_TUNING,
      surfaceChromaGain: 6,
    },
  )
  assert.equal(variables['--ron-kamicha-color'], 'rgb(44 143 197)')
  assert.equal(variables['--ron-toimen-color'], 'rgb(211 154 58)')
  assert.equal(variables['--ron-shimocha-color'], 'rgb(76 175 80)')
})
