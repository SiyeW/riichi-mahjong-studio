const fs = require('node:fs')
const path = require('node:path')
const { clipboard, shell } = require('electron')

const { discoverEnginePackages } = require('../state/engine-package-registry')

const APP_LEGAL_DOCUMENTS = Object.freeze({
  license: 'LICENSE',
  thirdPartyNotices: 'THIRD_PARTY_NOTICES.md',
})

async function openLocalDocument(filePath, t) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(t('native.legal.missing'))
  }
  const errorMessage = await shell.openPath(filePath)
  if (errorMessage) throw new Error(errorMessage)
  return true
}

function registerApplicationIpc({
  ipcMain,
  appOptions,
  resourceRoot,
  collectRuntimeMetrics,
  t,
}) {
  ipcMain.handle('system:runtime-metrics', () => collectRuntimeMetrics())
  ipcMain.handle('clipboard:read-text', () => clipboard.readText())
  ipcMain.handle('clipboard:write-text', (event, text) => {
    clipboard.writeText(String(text || ''))
    return { ok: true }
  })
  ipcMain.handle('system:open-external', async (event, value) => {
    const target = new URL(String(value || ''))
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new Error(t('native.legal.webOnly'))
    }
    await shell.openExternal(target.toString())
    return true
  })
  ipcMain.handle('legal:open-app-document', async (event, documentId) => {
    const fileName = APP_LEGAL_DOCUMENTS[String(documentId || '')]
    if (!fileName) throw new Error(t('native.legal.unknownDocument'))
    return openLocalDocument(path.join(resourceRoot, fileName), t)
  })
  ipcMain.handle('legal:open-engine-document', async (event, payload) => {
    const field = payload?.kind === 'license'
      ? 'licenses'
      : payload?.kind === 'notice'
        ? 'notices'
        : ''
    if (!field) throw new Error(t('native.legal.unknownEngineType'))
    const engineId = String(payload?.engineId || '')
    const documentIndex = Number(payload?.index)
    const engine = discoverEnginePackages(appOptions).engines.find((item) => item.id === engineId)
    const document = Number.isInteger(documentIndex) ? engine?.[field]?.[documentIndex] : null
    if (!document?.available) throw new Error(t('native.legal.engineDocumentMissing'))
    return openLocalDocument(document.resolvedPath, t)
  })
}

module.exports = { registerApplicationIpc }
