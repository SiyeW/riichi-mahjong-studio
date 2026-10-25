function registerStartupEngineRestore(ipcMain, restoreLoadedProfiles, logError = console.error) {
  let started = false
  ipcMain.on('app:bootstrap-complete', () => {
    if (started) return
    started = true
    void Promise.resolve().then(restoreLoadedProfiles).catch((error) => {
      logError('[engine] failed to start profile restoration:', error)
    })
  })
}

module.exports = { registerStartupEngineRestore }
