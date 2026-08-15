const assert = require('node:assert/strict')
const test = require('node:test')

const catalogs = {
  'zh-CN': require('./zh-CN.json'),
  'ja-JP': require('./ja-JP.json'),
  'en-US': require('./en-US.json'),
}

function placeholders(value) {
  return [...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)]
    .map((match) => match[1])
    .sort()
}

test('all locale catalogs expose the same keys and placeholders', () => {
  const referenceKeys = Object.keys(catalogs['zh-CN']).sort()
  for (const [locale, catalog] of Object.entries(catalogs)) {
    assert.deepEqual(Object.keys(catalog).sort(), referenceKeys, `${locale} keys`)
    for (const key of referenceKeys) {
      assert.equal(typeof catalog[key], 'string', `${locale}:${key} value`)
      assert.deepEqual(
        placeholders(catalog[key]),
        placeholders(catalogs['zh-CN'][key]),
        `${locale}:${key} placeholders`,
      )
    }
  }
})
