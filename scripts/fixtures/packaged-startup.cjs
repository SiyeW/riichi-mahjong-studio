const path = require('node:path')
const { app, dialog } = require('electron')
const directory = process.env.RMS_PACKAGED_TEST_DIR
if (!directory) throw new Error('Packaged smoke requires an isolated directory.')

app.setPath('userData', path.join(directory, 'browser'))
global.packagedSmokeWarnings = []
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(directory, 'records', 'example-record.mjstudio')] })
dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(directory, 'records', 'saved.mjstudio') })
dialog.showMessageBox = async (_window, options) => {
  global.packagedSmokeWarnings.push({ message: options.message, detail: options.detail })
  return { response: 0 }
}
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.on('browser-window-created', (_event, window) => {
  window.setFocusable(false)
  window.setSkipTaskbar(true)
  window.webContents.setBackgroundThrottling(false)
  window.show = () => {}
  window.maximize = () => {}
})
