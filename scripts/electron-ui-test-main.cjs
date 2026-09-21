const { app, BrowserWindow } = require('electron')

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
