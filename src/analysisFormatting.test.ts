import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import { createAnalysisFormatting } from './analysisFormatting.ts'

const formatting = createAnalysisFormatting(
  (key, params) => `${key}:${JSON.stringify(params || {})}`,
  ref('zh-CN'),
)

test('mahjong score labels use hundreds without rounding distinct scores together', () => {
  assert.equal(formatting.formatMahjongScore(3900), '39')
  assert.equal(formatting.formatMahjongScore(8000), '80')
  assert.equal(formatting.formatMahjongScore(11600), '116')
  assert.equal(formatting.formatMahjongScore(11700), '117')
  assert.equal(formatting.formatMahjongScore(12000), '120')
})

test('mahjong score labels preserve nonstandard distribution values', () => {
  assert.equal(formatting.formatMahjongScore('12000+'), '12000+')
  assert.equal(formatting.formatMahjongScore(1250), '1,250')
})

test('score distribution tooltips retain the exact point value', () => {
  assert.equal(formatting.formatDistributionPoints(11600), '11,600')
  assert.equal(formatting.formatDistributionPoints(11700), '11,700')
  assert.equal(formatting.formatDistributionPoints(12000), '12,000')
})
