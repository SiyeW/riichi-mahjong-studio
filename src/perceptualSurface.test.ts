import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PERCEPTUAL_COLOR_CALIBRATION_BACKGROUND,
  perceptualSurfaceVariables,
  type PerceptualColorPalette,
} from './perceptualSurface.ts'

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

test('every semantic color uses the same surface translation', () => {
  const variables = perceptualSurfaceVariables(palette, [9, 72, 85])
  assert.equal(variables['--ron-kamicha-color'], 'rgb(50 160 220)')
  assert.equal(variables['--ron-toimen-color'], 'rgb(224 173 87)')
  assert.equal(variables['--ron-shimocha-color'], 'rgb(82 194 104)')
  assert.equal(variables['--analysis-self-deal-in-color'], 'rgb(216 105 99)')
  assert.equal(variables['--analysis-draw-color'], variables['--ron-kamicha-color'])
  assert.equal(variables['--analysis-self-win-color'], variables['--ron-shimocha-color'])
  assert.equal(variables['--analysis-horizontal-color'], variables['--ron-toimen-color'])
})

test('neutral anchors remain fixed after surface translation', () => {
  const variables = perceptualSurfaceVariables(palette, [9, 72, 85])
  assert.equal(variables['--analysis-rank-1-color'], 'rgb(235 235 235)')
  assert.equal(variables['--analysis-rank-4-color'], variables['--ron-kamicha-color'])
})
