const assert = require('node:assert/strict')
const test = require('node:test')
const { createMainWindow, resolveZoomShortcut } = require('./main-window')

test('zoom shortcuts accept platform modifiers and reject unrelated input', () => {
  assert.equal(resolveZoomShortcut({ type: 'keyDown', control: true, meta: false, alt: false, code: 'Equal' }), 'in')
  assert.equal(resolveZoomShortcut({ type: 'keyDown', control: false, meta: true, alt: false, code: 'Minus' }), 'out')
  assert.equal(resolveZoomShortcut({ type: 'keyDown', control: true, meta: false, alt: false, code: 'Digit0' }), 'reset')
  assert.equal(resolveZoomShortcut({ type: 'keyUp', control: true, meta: false, alt: false, code: 'Equal' }), null)
  assert.equal(resolveZoomShortcut({ type: 'keyDown', control: true, meta: false, alt: true, code: 'Equal' }), null)
})

test('main window owns construction, first display, and close persistence', async () => {
  let constructedOptions
  let savedSettings
  let closeHandler
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
    saveSettingsImpl: (value) => { savedSettings = value },
    requestRendererFlushImpl: async (...args) => calls.push(['requestRendererFlush', ...args]),
    persistBeforeCloseImpl: async (flush, shouldRecover, recover) => {
      await flush()
      if (shouldRecover()) await recover()
    },
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

  let prevented = false
  closeHandler({ preventDefault: () => { prevented = true } })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(prevented, true)
  assert.deepEqual(savedSettings.window, { width: 1400, height: 900 })
  assert.deepEqual(calls.slice(4), [
    ['requestRendererFlush', window, ipcMain, 'native.closeSaveTimeout'],
    ['writeRecoveryGameRecord'],
    ['close'],
  ])
})
