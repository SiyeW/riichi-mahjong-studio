const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { registerSettingsIpc } = require('./settings-ipc')
const { loadSettings } = require('../state/settings')

test('interleaved partial saves preserve independent persisted settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-settings-ipc-'))
  try {
    const options = { appDir: root, portableDir: root, resourceDir: root, env: {}, cwd: root, isPackaged: false }
    const handlers = new Map()
    registerSettingsIpc({ handle: (id, handler) => handlers.set(id, handler) }, options)
    const save = patch => handlers.get('settings:save')({}, patch)
    const initial = loadSettings(options)
    save({ training: { mistakeThreshold: 0.4 } })
    save({ audio: { volume: 20 } })
    save({ display: { uiScale: 1.25 } })
    save({ training: { thinkingTimeMaxS: 2 } })
    save({ display: { colorScheme: 'naga' } })
    const stored = loadSettings(options)
    assert.equal(stored.training.mistakeThreshold, 0.4)
    assert.equal(stored.training.thinkingTimeMaxS, 2)
    assert.equal(stored.training.mode, initial.training.mode)
    assert.equal(stored.training.thinkingTimeMinS, initial.training.thinkingTimeMinS)
    assert.equal(stored.audio.volume, 20)
    assert.equal(stored.display.uiScale, 1.25)
    assert.equal(stored.display.colorScheme, 'naga')
    assert.deepEqual(stored.engines, initial.engines)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
