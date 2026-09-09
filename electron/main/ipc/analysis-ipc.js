function registerAnalysisIpc({ ipcMain, backendGateway, markRecordDirty }) {
  ipcMain.handle('analysis:visibility', (event, visibility) => backendGateway.setAnalysisVisibility(visibility))
  ipcMain.handle('analysis:get', () => backendGateway.getAnalysis())
  ipcMain.handle('debug:analysis', () => backendGateway.getAnalysisDebug())
  ipcMain.handle('debug:clear-analysis-caches', async () => {
    const response = await backendGateway.clearAnalysisCaches()
    const cleared = response.cleared || {}
    if (
      Number(cleared.mortalEntries || 0) > 0
      || Number(cleared.opponentEntries || 0) > 0
      || Number(cleared.comparisons || 0) > 0
      || Boolean(cleared.pendingReview)
    ) {
      markRecordDirty()
    }
    return response
  })
  ipcMain.handle('analysis:auto-start', () => backendGateway.startAutoAnalysis())
  ipcMain.handle('analysis:auto-cancel', () => backendGateway.cancelAutoAnalysis())
}

module.exports = { registerAnalysisIpc }
