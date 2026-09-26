const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const { createMainWindow, resolveZoomShortcut } = require('./main-window')

test('zoom shortcuts accept platform modifiers and reject unrelated input', () => {
  assert.equal(resolveZoomShortcut({ type: 'keyDown', control: true, meta: false, alt: false, code: 'Equal' }), 'in')
  assert.equal(resolveZoomShortcut({ type: 'keyDown', control: false, meta: true, alt: false, code: 'Minus' }), 'out')
  assert.equal(resolveZoomShortcut({ type: 'keyDown', control: true, meta: false, alt: false, code: 'Digit0' }), 'reset')
  assert.equal(resolveZoomShortcut({ type: 'keyUp', control: true, meta: false, alt: false, code: 'Equal' }), null)
  assert.equal(resolveZoomShortcut({ type: 'keyDown', control: true, meta: false, alt: true, code: 'Equal' }), null)
})

test('main window saves size after resize and does not rewrite settings on close', async () => {
  let constructedOptions
  let savedSettings
  let settingsSaveCount = 0
  let closeHandler
  let resizeSave
  const windowEvents = new Map()
  const webEvents = new Map()
  const calls = []
  class BrowserWindow {
    constructor(options) {
      constructedOptions = options
      this.webContents = {
        on: (name, handler) => webEvents.set(name, handler),
        once: (name, handler) => webEvents.set(name, handler),
        send: (...args) => calls.push(['send', ...args]),
        setZoomFactor: (factor) => calls.push(['setZoomFactor', factor]),
      }
    }
    close() { calls.push(['close']) }
    getSize() { return [1400, 900] }
    isDestroyed() { return false }
    isVisible() { return false }
    loadURL(url) { calls.push(['loadURL', url]) }
    maximize() { calls.push(['maximize']) }
    on(name, handler) {
      windowEvents.set(name, handler)
      if (name === 'close') closeHandler = handler
    }
    once(name, handler) { windowEvents.set(name, handler) }
    show() { calls.push(['show']) }
  }
  const settings = {
    window: { width: 1200, height: 800 },
    records: { saveRecoveryOnExit: true },
  }
  const ipcMain = {}
  const gameFileStore = { isDirty: () => true }
  const window = createMainWindow({
    BrowserWindow,
    dialog: {},
    ipcMain,
    appOptions: { test: true },
    projectRoot: 'D:\\project',
    isDev: true,
    rendererUrl: 'http://127.0.0.1:5173',
    gameFileStore,
    writeRecoveryGameRecord: async () => calls.push(['writeRecoveryGameRecord']),
    t: (key) => key,
    loadSettingsImpl: () => structuredClone(settings),
    saveSettingsImpl: (value) => { savedSettings = value; settingsSaveCount += 1 },
    requestRendererFlushImpl: async (...args) => calls.push(['requestRendererFlush', ...args.slice(0, 3)]),
    persistBeforeCloseImpl: async (flush, shouldRecover, recover, onStage) => {
      onStage('flushing')
      await flush()
      if (shouldRecover()) {
        onStage('recovery')
        await recover()
      }
    },
    setTimeoutImpl: (callback) => { resizeSave = callback; return 1 },
    clearTimeoutImpl: () => {},
  })

  assert.equal(constructedOptions.width, 1200)
  assert.equal(constructedOptions.height, 800)
  assert.equal(constructedOptions.webPreferences.contextIsolation, true)
  windowEvents.get('ready-to-show')()
  assert.deepEqual(calls.slice(0, 4), [
    ['setZoomFactor', 1],
    ['loadURL', 'http://127.0.0.1:5173'],
    ['maximize'],
    ['show'],
  ])
  windowEvents.get('resize')()
  resizeSave()
  assert.deepEqual(savedSettings.window, { width: 1400, height: 900 })
  assert.equal(settingsSaveCount, 1)

  let prevented = false
  closeHandler({ preventDefault: () => { prevented = true } })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(prevented, true)
  assert.deepEqual(savedSettings.window, { width: 1400, height: 900 })
  assert.equal(settingsSaveCount, 1)
  assert.deepEqual(calls.slice(4), [
    ['send', 'record:close-state', { active: true, stage: 'preparing' }],
    ['send', 'record:close-state', { active: true, stage: 'flushing' }],
    ['requestRendererFlush', window, ipcMain, 'native.closeSaveTimeout'],
    ['send', 'record:close-state', { active: true, stage: 'recovery' }],
    ['writeRecoveryGameRecord'],
    ['close'],
  ])
})

test('development window retries a failed main-frame load and cancels pending retry on close', async () => {
  const webEvents = new Map()
  const windowEvents = new Map()
  const loads = []
  const timers = []
  class BrowserWindow {
    constructor() {
      this.webContents = {
        on: (name, handler) => webEvents.set(name, handler),
        once: (name, handler) => webEvents.set(name, handler),
        setZoomFactor() {},
      }
    }
    isDestroyed() { return false }
    isVisible() { return false }
    loadURL(url) { loads.push(url); return Promise.resolve() }
    on(name, handler) { windowEvents.set(name, handler) }
    once(name, handler) { windowEvents.set(name, handler) }
    maximize() {}
    show() {}
  }
  createMainWindow({
    BrowserWindow,
    dialog: {},
    ipcMain: {},
    appOptions: {},
    projectRoot: 'D:\\project',
    isDev: true,
    rendererUrl: 'http://127.0.0.1:5173',
    gameFileStore: {},
    writeRecoveryGameRecord: async () => {},
    t: (key) => key,
    loadSettingsImpl: () => ({ window: { width: 1200, height: 800 } }),
    setTimeoutImpl: (callback) => { timers.push(callback); return timers.length },
    clearTimeoutImpl: (id) => { timers[id - 1] = null },
  })

  assert.equal(loads.length, 1)
  webEvents.get('did-fail-load')(null, -105, 'ERR_NAME_NOT_RESOLVED', 'http://127.0.0.1:5173/', false)
  assert.equal(timers.length, 0)
  webEvents.get('did-fail-load')(null, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5173/', true)
  assert.equal(timers.length, 1)
  await new Promise((resolve) => setImmediate(resolve))
  timers[0]()
  assert.equal(loads.length, 2)
  webEvents.get('did-fail-load')(null, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:5173/', true)
  assert.equal(timers.length, 2)
  windowEvents.get('closed')()
  assert.equal(timers[1], null)
})

test('canceling a failed close restores interaction and permits a later complete save', async () => {
  const states = []
  let closes = 0
  let flushes = 0
  let writes = 0
  class Window extends EventEmitter {
    constructor() {
      super()
      this.webContents = new EventEmitter()
      this.webContents.setZoomFactor = () => {}
      this.webContents.send = (channel, payload) => {
        if (channel === 'record:close-state') states.push(payload)
      }
    }
    isDestroyed() { return false }
    loadURL() { return Promise.resolve() }
    close() { closes += 1 }
  }
  const window = createMainWindow({
    BrowserWindow: Window, dialog: { showMessageBox: async () => ({ response: 0 }) },
    ipcMain: {}, appOptions: {}, projectRoot: process.cwd(), isDev: true, rendererUrl: 'unused',
    gameFileStore: { isDirty: () => true }, t: key => key,
    loadSettingsImpl: () => ({ window: { width: 1200, height: 800 }, records: { saveRecoveryOnExit: true } }),
    requestRendererFlushImpl: async () => { if (++flushes === 1) throw new Error('pending edit failed') },
    writeRecoveryGameRecord: async onStage => { writes += 1; onStage('encoding'); onStage('writing') },
  })
  const requestClose = () => window.emit('close', { preventDefault() {} })
  requestClose()
  requestClose()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(flushes, 1, 'duplicate close events must not start another save')
  assert.equal(writes, 0)
  assert.equal(closes, 0)
  assert.deepEqual(states.at(-1), { active: false, stage: '' })
  requestClose()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(writes, 1)
  assert.equal(closes, 1)
  assert.deepEqual(states.slice(-2).map(state => state.stage), ['encoding', 'writing'])
})
