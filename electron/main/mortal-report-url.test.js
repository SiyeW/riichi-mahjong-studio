const assert = require('node:assert/strict')
const { test } = require('node:test')

const { normalizeMortalReportUrl } = require('./mortal-report-url')

const REPORT_URL = 'https://mjai.ekyu.moe/report/96113a5b9f2e286b.json'

test('normalizes Mortal progress task links', () => {
  assert.equal(
    normalizeMortalReportUrl('https://mjai.ekyu.moe/progress?task=96113a5b9f2e286b'),
    REPORT_URL,
  )
  assert.equal(
    normalizeMortalReportUrl('https://mjai.ekyu.moe/progress/?task=96113a5b9f2e286b'),
    REPORT_URL,
  )
})

test('keeps all existing report input forms compatible', () => {
  assert.equal(normalizeMortalReportUrl('96113a5b9f2e286b'), REPORT_URL)
  assert.equal(normalizeMortalReportUrl(REPORT_URL), REPORT_URL)
  assert.equal(
    normalizeMortalReportUrl('https://mjai.ekyu.moe/killerducky/?data=/report/96113a5b9f2e286b.json'),
    REPORT_URL,
  )
})

test('rejects malformed task IDs and foreign hosts', () => {
  assert.throws(
    () => normalizeMortalReportUrl('https://mjai.ekyu.moe/progress?task=short'),
    /未能从网址中识别/,
  )
  assert.throws(
    () => normalizeMortalReportUrl('https://example.com/progress?task=96113a5b9f2e286b'),
    /只支持 mjai\.ekyu\.moe/,
  )
})
