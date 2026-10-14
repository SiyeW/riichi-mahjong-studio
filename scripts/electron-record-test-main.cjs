// Full production entrypoint, isolated files/dialogs and a non-interactive window.
const path = require('node:path')
const { app, dialog } = require('electron')
const directory = process.env.RMS_RECORD_DESKTOP_TEST_DIR
if (!directory) throw new Error('An isolated desktop test directory is required.')
const root = path.resolve(__dirname, '..')
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
  return backend
}
const storeModule = require('../electron/main/state/game-file-store')
const createStore = storeModule.createGameFileStore
storeModule.createGameFileStore = () => createStore(directory)

global.recordDesktopTest = { dialogs: [], nextOpen: path.join(directory, 'records', 'example-record.mjstudio') }
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
app.on('browser-window-created', (_event, window) => {
  // Never show, focus, maximize or place this test window on the user's taskbar.
  window.setFocusable(false)
  window.setSkipTaskbar(true)
  window.setOpacity(0)
  window.webContents.setBackgroundThrottling(false)
  window.show = () => {}
  window.maximize = () => {}
})
require(path.join(root, 'electron', 'main', 'index.js'))
