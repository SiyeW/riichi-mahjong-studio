const enUS = require('../../locales/en-US.json')
const jaJP = require('../../locales/ja-JP.json')
const zhCN = require('../../locales/zh-CN.json')

const catalogs = Object.freeze({
  'zh-CN': zhCN,
  'ja-JP': jaJP,
  'en-US': enUS,
})

function normalizeLocale(value) {
  const locale = String(value || '').toLowerCase()
  if (locale === 'ja' || locale.startsWith('ja-')) return 'ja-JP'
  if (locale === 'zh' || locale.startsWith('zh-')) return 'zh-CN'
  return 'en-US'
}

function resolveLocale(preference, systemLocale = '') {
  if (preference === 'zh-CN' || preference === 'ja-JP' || preference === 'en-US') {
    return preference
  }
  return normalizeLocale(systemLocale)
}

function translate(locale, key, params = {}) {
  const catalog = catalogs[resolveLocale(locale)] || catalogs['en-US']
  const template = catalog[key] ?? catalogs['zh-CN'][key] ?? key
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ))
}

function createTranslator({ getPreference, getSystemLocale }) {
  return (key, params = {}) => translate(
    resolveLocale(getPreference(), getSystemLocale()),
    key,
    params,
  )
}

module.exports = { createTranslator, normalizeLocale, resolveLocale, translate }
