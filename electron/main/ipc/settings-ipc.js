const { buildSettings, loadSettings, saveSettings } = require('../state/settings')

function registerSettingsIpc(ipcMain, appOptions) {
  ipcMain.handle('settings:get', () => buildSettings(loadSettings(appOptions), appOptions))

  ipcMain.handle('settings:save', (event, patch) => {
    const current = loadSettings(appOptions)
    const next = {
      ...current,
      ...patch,
      modeDefaults: {
        ...current.modeDefaults,
        ...(patch?.modeDefaults || {}),
      },
      display: {
        ...current.display,
        ...(patch?.display || {}),
      },
      records: {
        ...current.records,
        ...(patch?.records || {}),
      },
      audio: {
        ...current.audio,
        ...(patch?.audio || {}),
      },
      window: {
        ...current.window,
        ...(patch?.window || {}),
      },
    }
    saveSettings(next, appOptions)
    return buildSettings(next, appOptions)
  })
}

module.exports = { registerSettingsIpc }
