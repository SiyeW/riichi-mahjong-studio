const { buildSettings, loadSettings, saveSettings } = require('../state/settings')

function registerSettingsIpc(ipcMain, appOptions, settingsChanged = () => {}) {
  ipcMain.handle('settings:get', () => buildSettings(loadSettings(appOptions), appOptions))

  ipcMain.handle('settings:save', async (event, patch) => {
    const current = loadSettings(appOptions)
    const next = {
      ...current,
      ...patch,
      training: {
        ...current.training,
        ...(patch?.training || {}),
      },
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
    await settingsChanged(next)
    return buildSettings(next, appOptions)
  })
}

module.exports = { registerSettingsIpc }
