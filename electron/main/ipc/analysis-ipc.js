function registerAnalysisIpc({ ipcMain, environmentGateway, markRecordDirty }) {
  ipcMain.handle('analysis:visibility', (event, visibility) => environmentGateway.setAnalysisVisibility(visibility))
  ipcMain.handle('game:shanten', () => environmentGateway.getShanten())
  ipcMain.handle('debug:shanten-mjai', () => environmentGateway.getShantenMjai())
  ipcMain.handle('debug:clear-analysis-caches', async () => {
    const response = await environmentGateway.clearAnalysisCaches()
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
  ipcMain.handle('analysis:auto-start', () => environmentGateway.startAutoAnalysis())
  ipcMain.handle('analysis:auto-cancel', () => environmentGateway.cancelAutoAnalysis())
}

module.exports = { registerAnalysisIpc }
