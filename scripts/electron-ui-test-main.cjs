const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const browserDirectory = process.env.RMS_UI_TEST_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'rms-ui-browser-'))
fs.mkdirSync(browserDirectory, { recursive: true })
app.setPath('userData', browserDirectory)
app.on('will-quit', () => {
  if (!process.env.RMS_UI_TEST_DATA_DIR) {
    // Session files may still be held briefly on Windows; do not fail shutdown.
    try { fs.rmSync(browserDirectory, { recursive: true, force: true }) } catch { /* OS releases remaining cache files on exit. */ }
  }
})

const rendererUrl = process.env.RMS_UI_TEST_URL
if (!rendererUrl) throw new Error('RMS_UI_TEST_URL is required')

app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')

app.whenReady().then(() => {
  const window = new BrowserWindow({
    show: true,
    width: 2560,
    height: 1392,
    opacity: 0,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      backgroundThrottling: false,
    },
  })
  void window.loadURL(rendererUrl)
})

app.on('window-all-closed', () => app.quit())
