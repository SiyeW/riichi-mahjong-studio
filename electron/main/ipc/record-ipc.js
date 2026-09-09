const fs = require('node:fs')
const path = require('node:path')
const { normalizeMortalReportUrl } = require('../mortal-report-url')
const { readLimitedResponseText } = require('../services/limited-response')
const { withCurrentRecord } = require('../state/record-operation')

async function downloadMortalReport(rawInput, { fetchImpl = fetch, t, timeoutMs = 20000 }) {
  const sourceUrl = normalizeMortalReportUrl(rawInput, t)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(sourceUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(t('native.download.http', { status: response.status }))
    const text = await readLimitedResponseText(
      response,
      25 * 1024 * 1024,
      t('native.download.tooLarge'),
    )
    let report
    try {
      report = JSON.parse(text)
    } catch {
      throw new Error(t('native.download.invalidJson'))
    }
    if (!report || !Array.isArray(report.mjai_log) || !report.mjai_log.length) {
      throw new Error(t('native.download.noLog'))
    }
    return { report, sourceUrl }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(t('native.download.timeout'))
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function registerRecordIpc({
  ipcMain,
  shell,
  backendGateway,
  gameFileStore,
  beginRecordTracking,
  openGame,
  restoreStartupRecovery,
  saveGame,
  saveGameAs,
  t,
  downloadReport = (input) => downloadMortalReport(input, { t }),
}) {
  ipcMain.handle('record:dirty-get', () => gameFileStore.isDirty())
  ipcMain.handle('game:save', () => saveGame())
  ipcMain.handle('game:save-as', () => saveGameAs())
  ipcMain.handle('game:open', () => openGame())
  ipcMain.handle('record:show-in-folder', () => {
    const recordPath = gameFileStore.getCurrentPath()
    if (!recordPath || !fs.existsSync(recordPath)) return false
    shell.showItemInFolder(recordPath)
    return true
  })
  ipcMain.handle('game:restore-startup-recovery', () => restoreStartupRecovery())
  ipcMain.handle('game:import-mortal-report', async (event, payload) => {
    const request = typeof payload === 'string' ? { input: payload } : (payload || {})
    const originalInput = String(request.input || '').trim()
    const { report, sourceUrl } = await withCurrentRecord(
      gameFileStore,
      () => downloadReport(originalInput),
    )
    const response = await backendGateway.importMortalReport(report, sourceUrl, {
      sourceImportUrl: originalInput,
      reconstructWalls: Boolean(request.reconstructWalls),
      seed: request.seed,
    })
    gameFileStore.prepareUnsavedRecord(path.basename(new URL(sourceUrl).pathname, '.json'))
    beginRecordTracking({ dirty: true, nodeId: response.view?.currentNodeId })
    return {
      sourceUrl,
      reconstruction: response.reconstruction || null,
      state: response.state,
      view: response.view,
      recordDirty: true,
    }
  })
  ipcMain.handle('game:import-custom-tenhou', async (event, payload) => {
    const request = typeof payload === 'string' ? { input: payload } : (payload || {})
    const response = await backendGateway.importCustomTenhou(request.input, {
      reconstructWalls: Boolean(request.reconstructWalls),
      seed: request.seed,
    })
    gameFileStore.prepareUnsavedRecord('custom-tenhou')
    beginRecordTracking({ dirty: true, nodeId: response.view?.currentNodeId })
    return {
      reconstruction: response.reconstruction || null,
      state: response.state,
      view: response.view,
      recordDirty: true,
    }
  })
  ipcMain.handle('game:export-custom-tenhou', async () => {
    const response = await backendGateway.exportCustomTenhou()
    return response.customTenhou
  })
}

module.exports = { downloadMortalReport, registerRecordIpc }
