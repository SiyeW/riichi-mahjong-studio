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

test('point formatting reuses locale formatters and refreshes them on language change', (t) => {
  const NumberFormat = Intl.NumberFormat
  let constructions = 0
  t.mock.method(Intl, 'NumberFormat', function (locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
    constructions++
    return new NumberFormat(locales, options)
  })
  const locale = ref('en-US')
  const current = createAnalysisFormatting(key => key, locale)
  for (let index = 0; index < 200; index++) {
    assert.equal(current.formatCompactPoints(3900), '3900')
    assert.equal(current.formatCompactPoints(-12345), '-12.3K')
  }
  assert.equal(constructions, 2, 'one standard and one compact formatter for the active locale')
  locale.value = 'ja-JP'
  assert.equal(current.formatCompactPoints(12345), '1.2万')
  assert.equal(current.formatSignedCompactPoints(-12345), '−1.2万')
  assert.equal(constructions, 4)
  assert.equal(current.formatCompactPoints(null), '—')
  assert.equal(current.formatCompactPoints(Number.NaN), '—')
  assert.equal(constructions, 4, 'unavailable values do not construct formatters')
})
