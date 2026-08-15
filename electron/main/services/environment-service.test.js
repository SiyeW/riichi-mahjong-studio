const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { resolveAppVersion, resolveDevelopmentPython } = require('./environment-service')

function testAppVersionResolution() {
  assert.equal(resolveAppVersion({ appVersion: '1.0.0-dev.0' }), '1.0.0-dev.0')
  assert.equal(resolveAppVersion({ appVersion: ' 1.0.0 ' }), '1.0.0')
  assert.equal(resolveAppVersion({}), '0.0.0-dev')
}

function testDevelopmentPythonResolution() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mjai-python-runtime-'))
  const localPython = process.platform === 'win32'
    ? path.join(root, '.conda-backend', 'python.exe')
    : path.join(root, '.conda-backend', 'bin', 'python')
  try {
    fs.mkdirSync(path.dirname(localPython), { recursive: true })
    fs.writeFileSync(localPython, '')

    assert.equal(resolveDevelopmentPython(root, {}), localPython)
    assert.equal(
      resolveDevelopmentPython(root, { MJAI_BACKEND_PYTHON: 'custom-python' }),
      'custom-python',
    )

    fs.rmSync(localPython)
    assert.equal(resolveDevelopmentPython(root, {}), 'python')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

testAppVersionResolution()
testDevelopmentPythonResolution()
console.log('environment service tests passed')
