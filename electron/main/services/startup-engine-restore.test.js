const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const { registerStartupEngineRestore } = require('./startup-engine-restore')

test('engine restoration waits for renderer bootstrap and starts only once', async () => {
  const ipcMain = new EventEmitter()
  let starts = 0
  registerStartupEngineRestore(ipcMain, () => { starts += 1 })
  await Promise.resolve()
  assert.equal(starts, 0)
  ipcMain.emit('app:bootstrap-complete')
  await Promise.resolve()
  assert.equal(starts, 1)
  ipcMain.emit('app:bootstrap-complete')
  await Promise.resolve()
  assert.equal(starts, 1)
})

test('a restoration error stays isolated from application startup', async () => {
  const ipcMain = new EventEmitter()
  const errors = []
  registerStartupEngineRestore(ipcMain, () => { throw new Error('unsupported weight') }, (...args) => errors.push(args))
  ipcMain.emit('app:bootstrap-complete')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(errors.length, 1)
  assert.match(errors[0][1].message, /unsupported weight/)
})
