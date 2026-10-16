// Full production entrypoint and isolated files/dialogs. Normal interactive
// surfaces require explicit opt-in; ordinary correctness tests stay invisible.
const path = require('node:path')
const { app, dialog, screen, powerMonitor, powerSaveBlocker } = require('electron')
const directory = process.env.RMS_RECORD_DESKTOP_TEST_DIR
if (!directory) throw new Error('An isolated desktop test directory is required.')
const root = path.resolve(__dirname, '..')
require('node:fs').mkdirSync(path.join(directory, 'browser'), { recursive: true })
app.setPath('userData', path.join(directory, 'browser'))
process.env.RMS_BACKEND_CONFIG = path.join(directory, 'config.json')

const backendModule = require('../electron/main/services/backend-service')
const createBackend = backendModule.createBackendService
backendModule.createBackendService = options => {
  const backend = createBackend({ ...options, portableDir: directory })
  const capture = backend.backendGateway.captureRecordSave
  backend.backendGateway.captureRecordSave = async (...args) => {
    const token = await capture(...args)
    global.recordDesktopTest.lastSaveToken = token
    return token
  }
  if (process.env.RMS_RECORD_MOTION_PROFILE) {
    const jump = backend.backendGateway.jumpToNode
    backend.backendGateway.jumpToNode = async (...args) => {
      const start = performance.now()
      const result = await jump(...args)
      global.recordDesktopTest.navigation.push({ requested: args[0], returned: result.view.currentNodeId,
        milliseconds: performance.now() - start })
      return result
    }
  }
  return backend
}
const storeModule = require('../electron/main/state/game-file-store')
const createStore = storeModule.createGameFileStore
storeModule.createGameFileStore = () => createStore(directory)

global.recordDesktopTest = { dialogs: [], navigation: [], nextOpen: path.join(directory, 'records', 'example-record.mjstudio') }
dialog.showOpenDialog = async (_window, options) => {
  global.recordDesktopTest.dialogs.push({ type: 'open', defaultPath: options.defaultPath })
  const file = global.recordDesktopTest.nextOpen
  return { canceled: !file, filePaths: file ? [file] : [] }
}
dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(directory, 'records', 'saved.mjstudio') })
dialog.showMessageBox = async (_window, options) => {
  global.recordDesktopTest.dialogs.push({ type: 'message', message: options.message, detail: options.detail })
  return { response: 0 }
}
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
let motionPowerBlocker = null
app.on('will-quit', () => {
  if (motionPowerBlocker !== null) powerSaveBlocker.stop(motionPowerBlocker)
})
app.on('browser-window-created', (_event, window) => {
  const events = { invalidations: 0, locks: 0 }
  window.rmsRecordSurfaceEvents = events
  const invalidate = () => { events.invalidations++ }
  const lock = () => { events.locks++; invalidate() }
  const observers = [
    [window, 'blur', invalidate], [window, 'hide', invalidate], [window, 'minimize', invalidate],
    [powerMonitor, 'lock-screen', lock], [powerMonitor, 'suspend', invalidate],
    [screen, 'display-metrics-changed', invalidate],
  ]
  observers.forEach(([owner, event, listener]) => owner.on(event, listener))
  window.once('closed', () => observers.forEach(([owner, event, listener]) => owner.removeListener(event, listener)))
  const visibleMotion = Boolean(process.env.RMS_RECORD_MOTION_PROFILE)
    && process.env.RMS_RECORD_MOTION_VISIBLE === '1'
  const focusedMotion = visibleMotion && process.env.RMS_RECORD_MOTION_FOCUSED === '1'
  const nativeSurface = focusedMotion && process.env.RMS_RECORD_MOTION_NATIVE_SURFACE === '1'
  if (nativeSurface && motionPowerBlocker === null) {
    motionPowerBlocker = powerSaveBlocker.start('prevent-display-sleep')
  }
  global.recordDesktopTest.preventDisplaySleep = motionPowerBlocker !== null
    && powerSaveBlocker.isStarted(motionPowerBlocker)
  global.recordDesktopTest.surfaceMode = nativeSurface ? 'native'
    : visibleMotion ? 'layered-diagnostic' : 'invisible-correctness'
  // Ordinary record tests stay invisible; focused performance testing needs a
  // second explicit opt-in and current user authority. Never show on the taskbar.
  window.setFocusable(focusedMotion)
  if (!nativeSurface) {
    window.setSkipTaskbar(true)
    window.setOpacity(visibleMotion ? 1 : 0)
  }
  if (visibleMotion) {
    window.setBounds(screen.getPrimaryDisplay().workArea)
    if (!nativeSurface) window.setIgnoreMouseEvents(true)
  }
  window.webContents.setBackgroundThrottling(false)
  // Motion profiling needs a renderable surface; keep it non-focusable.
  // Opaque display testing is explicit opt-in and uses no native
  // desktop-control tool. Hidden/transparent results are not displayed FPS.
  const show = window.show.bind(window)
  window.show = process.env.RMS_RECORD_MOTION_PROFILE ? () => {
    if (nativeSurface) show()
    else window.showInactive()
    if (focusedMotion) window.focus()
  } : () => {}
  window.maximize = () => {}
})
require(path.join(root, 'electron', 'main', 'index.js'))
