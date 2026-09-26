const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { registerAnalysisIpc } = require('../main/ipc/analysis-ipc')

const root = path.resolve(__dirname, '../..')

function loadPreloadBridge() {
  let exposed = null
  const invoked = []
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        exposed = { name, api }
      },
    },
    ipcRenderer: {
      invoke(channel) { invoked.push(channel) },
      on() {},
      removeListener() {},
      send() {},
    },
  }
  const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8')
  vm.runInNewContext(source, {
    require(request) {
      if (request === 'electron') return electron
      throw new Error(`Unexpected preload dependency: ${request}`)
    },
  }, { filename: 'electron/preload/index.cjs' })
  return { ...exposed, invoked }
}

function declaredBridgeMethods() {
  const source = fs.readFileSync(path.join(root, 'src/contracts/desktopBridge.ts'), 'utf8')
  const declaration = source.split('export interface DesktopBridge {', 2)[1]
  assert.ok(declaration, 'DesktopBridge declaration is missing')
  return [...declaration.matchAll(/^  ([A-Za-z]\w*):/gm)].map((match) => match[1]).sort()
}

test('preload exposes the complete authoritative desktop bridge', () => {
  const exposed = loadPreloadBridge()
  assert.equal(exposed?.name, 'studioAPI')
  assert.deepEqual(Object.keys(exposed?.api || {}).sort(), declaredBridgeMethods())
})

test('cache clearing uses a channel registered by the main process', () => {
  const exposed = loadPreloadBridge()
  const handlers = new Map()
  registerAnalysisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    backendGateway: {},
    markRecordDirty() {},
  })
  exposed.api.clearAnalysisCaches()
  assert.equal(exposed.invoked.length, 1)
  assert.ok(handlers.has(exposed.invoked[0]), `No main-process handler for ${exposed.invoked[0]}`)
})
