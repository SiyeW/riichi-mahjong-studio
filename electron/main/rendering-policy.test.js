const assert = require('node:assert/strict')
const test = require('node:test')
const { configurePageRasterization } = require('./rendering-policy')

function application(switches = []) {
  const appended = []
  return { appended, commandLine: {
    hasSwitch: name => switches.includes(name),
    appendSwitch: name => appended.push(name),
  }, disableHardwareAcceleration() { throw new Error('Whole-GPU acceleration must remain available') } }
}

test('Windows default selects CPU page rasterization without disabling all acceleration', () => {
  const app = application()
  configurePageRasterization(app, 'win32')
  assert.deepEqual(app.appended, ['disable-gpu-rasterization'])
})

test('explicit GPU or CPU rasterization overrides remain authoritative', () => {
  for (const flag of ['enable-gpu-rasterization', 'disable-gpu-rasterization']) {
    const app = application([flag])
    configurePageRasterization(app, 'win32')
    assert.deepEqual(app.appended, [])
  }
})

test('unmeasured platforms keep their existing rasterization policy', () => {
  for (const platform of ['darwin', 'linux']) {
    const app = application()
    configurePageRasterization(app, platform)
    assert.deepEqual(app.appended, [])
  }
})
