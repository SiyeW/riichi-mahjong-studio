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
  assert.equal(formatting.formatMahjongScore(1250), '1250')
})

test('point values never use locale grouping separators', () => {
  assert.equal(formatting.formatPlainPoints(25000), '25000')
  assert.equal(formatting.formatPoints(11600), 'analysis.points:{"value":"11600"}')
  assert.equal(formatting.formatDistributionPoints(11600), '11600')
  assert.equal(formatting.formatDistributionPoints(11700), '11700')
  assert.equal(formatting.formatDistributionPoints(12000), '12000')
})
