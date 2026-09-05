const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const { requestRendererFlush, persistBeforeClose } = require('./close-persistence')

function fixture() {
  const ipc = new EventEmitter()
  const contents = new EventEmitter()
  contents.isLoading = () => false
  let token
  contents.send = (_channel, value) => { token = value }
  const window = { isDestroyed: () => false, webContents: contents }
  return { ipc, contents, window, get token() { return token }, reply: (error = '') => ipc.emit('record:close-ready', { sender: contents }, token, error) }
}

test('only the matching renderer and token can acknowledge a close flush', async () => {
  const f = fixture()
  let finished = false
  const saving = requestRendererFlush(f.window, f.ipc, 'timeout').then(() => { finished = true })
  f.ipc.emit('record:close-ready', { sender: f.contents }, 'wrong-token')
  f.ipc.emit('record:close-ready', { sender: {} }, f.token)
  await Promise.resolve()
  assert.equal(finished, false)
  f.reply()
  await saving
  assert.equal(f.ipc.listenerCount('record:close-ready'), 0)
  assert.equal(f.contents.listenerCount('destroyed'), 0)
})

test('renderer save errors block closing and clean up the listener', async () => {
  const f = fixture()
  const saving = requestRendererFlush(f.window, f.ipc, 'timeout')
  f.reply('save failed')
  await assert.rejects(saving, /save failed/)
  assert.equal(f.ipc.listenerCount('record:close-ready'), 0)
})

test('timeout is a failure, not permission to close', async () => {
  const f = fixture()
  await assert.rejects(requestRendererFlush(f.window, f.ipc, 'timed out', 5), /timed out/)
  assert.equal(f.ipc.listenerCount('record:close-ready'), 0)
  assert.equal(f.contents.listenerCount('destroyed'), 0)
  f.reply()
})

test('send failure and renderer destruction clean up pending flush requests', async () => {
  const f = fixture()
  f.contents.send = () => { throw new Error('send failed') }
  await assert.rejects(requestRendererFlush(f.window, f.ipc, 'timeout'), /send failed/)
  assert.equal(f.ipc.listenerCount('record:close-ready'), 0)
  const g = fixture()
  const saving = requestRendererFlush(g.window, g.ipc, 'renderer unavailable')
  g.contents.emit('destroyed')
  await assert.rejects(saving, /renderer unavailable/)
  assert.equal(g.ipc.listenerCount('record:close-ready'), 0)
})

test('recovery disabled still flushes the renderer', async () => {
  const calls = []
  await persistBeforeClose(async () => calls.push('flush'), () => false, async () => calls.push('recovery'))
  assert.deepEqual(calls, ['flush'])
})

test('recovery eligibility is checked after pending edits are saved', async () => {
  let dirty = false
  const calls = []
  await persistBeforeClose(async () => { dirty = true; calls.push('flush') }, () => dirty, async () => calls.push('recovery'))
  assert.deepEqual(calls, ['flush', 'recovery'])
})

test('flush failure never proceeds to recovery', async () => {
  let recovery = false
  await assert.rejects(persistBeforeClose(
    async () => { throw new Error('failed') },
    () => true,
    async () => { recovery = true },
  ), /failed/)
  assert.equal(recovery, false)
})
