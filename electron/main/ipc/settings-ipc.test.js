const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { registerSettingsIpc } = require('./settings-ipc')
const { loadSettings } = require('../state/settings')

test('motion blur defaults on and persists through fresh settings authorities and processes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-blur-settings-'))
  const options = { appDir: root, portableDir: root, resourceDir: root, env: {} }
  const register = () => {
    const handlers = new Map()
    registerSettingsIpc({ handle: (id, handler) => handlers.set(id, handler) }, options)
    return handlers
  }
  try {
    let handlers = register()
    assert.equal(handlers.get('settings:get')().display.tileMotionBlur, true)
    // Old files with no field inherit the new default too.
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ display: { reduceMotion: false } }))
    assert.equal(handlers.get('settings:get')().display.tileMotionBlur, true)
    const saved = await handlers.get('settings:save')({}, { display: { tileMotionBlur: false } })
    assert.equal(saved.display.tileMotionBlur, false)
    handlers = register()
    assert.equal(handlers.get('settings:get')().display.tileMotionBlur, false)
    const restarted = execFileSync(process.execPath, ['-e',
      'process.stdout.write(JSON.stringify(require(process.argv[1]).loadSettings(JSON.parse(process.argv[2])).display))',
      require.resolve('../state/settings'), JSON.stringify(options)], { encoding: 'utf8' })
    assert.equal(JSON.parse(restarted).tileMotionBlur, false)
    await handlers.get('settings:save')({}, { display: { tileMotionBlur: true, reduceMotion: true } })
    assert.equal(register().get('settings:get')().display.tileMotionBlur, true, 'reduced motion preserves the configured preference')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

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
