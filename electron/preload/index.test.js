const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { registerAnalysisIpc } = require('../main/ipc/analysis-ipc')

const root = path.resolve(__dirname, '../..')

function loadPreloadBridge() {
  let exposed = null
  const invoked = []
  const sent = []
  const ipc = new EventEmitter()
  ipc.invoke = (channel) => { invoked.push(channel) }
  ipc.send = (...args) => { sent.push(args) }
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        exposed = { name, api }
      },
    },
    ipcRenderer: ipc,
  }
  const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8')
  vm.runInNewContext(source, {
    require(request) {
      if (request === 'electron') return electron
      throw new Error(`Unexpected preload dependency: ${request}`)
    },
  }, { filename: 'electron/preload/index.cjs' })
  return { ...exposed, invoked, sent, ipc }
}

test('close requests are answered even before mount and after component cleanup', async () => {
  const f = loadPreloadBridge()
  f.ipc.emit('record:before-close', {}, 'before-mount')
  const unsubscribe = f.api.onBeforeClose(() => {})
  unsubscribe()
  unsubscribe()
  f.ipc.emit('record:before-close', {}, 'after-unmount')
  await Promise.resolve()
  assert.deepEqual(f.sent, [
    ['record:close-ready', 'before-mount', 'RENDERER_UNAVAILABLE'],
    ['record:close-ready', 'after-unmount', 'RENDERER_UNAVAILABLE'],
  ])
  assert.equal(f.ipc.listenerCount('record:before-close'), 1)
})

test('old root cleanup cannot remove a replacement close callback', async () => {
  const f = loadPreloadBridge()
  const unsubscribe = f.api.onBeforeClose(() => { throw new Error('old root') })
  let called = false
  f.api.onBeforeClose(() => { called = true })
  unsubscribe()
  f.ipc.emit('record:before-close', {}, 'replacement')
  await Promise.resolve()
  assert.equal(called, true)
  assert.deepEqual(f.sent, [['record:close-ready', 'replacement', '']])
})

test('in-flight close keeps its original callback and propagates save failure', async () => {
  const f = loadPreloadBridge()
  let reject
  const unsubscribe = f.api.onBeforeClose(() => new Promise((_resolve, fail) => { reject = fail }))
  f.ipc.emit('record:before-close', {}, 'pending')
  unsubscribe()
  f.api.onBeforeClose(() => {})
  assert.deepEqual(f.sent, [])
  reject('write failed')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.sent, [['record:close-ready', 'pending', 'write failed']])
})

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
