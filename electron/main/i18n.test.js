const assert = require('node:assert/strict')
const test = require('node:test')

const { createTranslator, resolveLocale, translate } = require('./i18n')

test('resolves supported system languages and defaults to English', () => {
  assert.equal(resolveLocale('system', 'zh-TW'), 'zh-CN')
  assert.equal(resolveLocale('system', 'ja'), 'ja-JP')
  assert.equal(resolveLocale('system', 'fr-FR'), 'en-US')
  assert.equal(resolveLocale('en-US', 'zh-CN'), 'en-US')
})

test('translates parameters with the selected catalog', () => {
  assert.equal(translate('zh-CN', 'seat.number', { seat: 2 }), '座位2')
  assert.equal(translate('ja-JP', 'seat.number', { seat: 2 }), '座席2')
  assert.equal(translate('en-US', 'seat.number', { seat: 2 }), 'Seat 2')
})

test('translator reads the preference at call time', () => {
  let preference = 'system'
  const t = createTranslator({
    getPreference: () => preference,
    getSystemLocale: () => 'ja-JP',
  })
  assert.equal(t('common.close'), '閉じる')
  preference = 'en-US'
  assert.equal(t('common.close'), 'Close')
})
