const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const { createBackendProcess } = require('./backend-process')

function fixture() {
  const children = []
  const events = []
  const backend = createBackendProcess({
    name: 'test', pythonExecutable: 'unused',
    spawnProcess() {
      const child = new EventEmitter()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.stdin = new EventEmitter()
      child.messages = []
      child.stdin.write = (text, callback) => { child.messages.push(JSON.parse(text)); callback?.() }
      child.kill = () => { child.killed = true }
      child.output = payload => child.stdout.emit('data', Buffer.from(JSON.stringify(payload) + '\n'))
      children.push(child)
      return child
    },
  })
  backend.onEvent(event => events.push(event))
  return { backend, children, events }
}

test('a synchronous spawn exception reports stopped and rejects the request', async () => {
  const events = []
  const backend = createBackendProcess({ name: 'test', pythonExecutable: 'unused',
    spawnProcess() { throw new Error('invalid launch configuration') } })
  backend.onEvent(event => events.push(event))
  await assert.rejects(backend.sendRequest('get_status'), /not running/)
  assert.equal(backend.isRunning(), false)
  assert.equal(events[0].type, 'service_stopped')
  assert.match(events[0].error, /invalid launch configuration/)
})

test('startup timeout drops its queued request while a later request can still run', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { backend, children } = fixture()
  const expired = assert.rejects(backend.sendRequest('expired'), /60 seconds/)
  t.mock.timers.tick(60_000)
  await expired
  const fresh = backend.sendRequest('fresh')
  children[0].output({ type: 'service_ready' })
  assert.deepEqual(children[0].messages.map(message => message.command), ['fresh'])
  children[0].output({ request_id: children[0].messages[0].request_id, ok: true })
  assert.equal((await fresh).ok, true)
  backend.stop()
})

test('callback errors are reported and do not prevent later replies', async t => {
  const logged = t.mock.method(console, 'error', () => {})
  const { backend, children } = fixture()
  backend.onEvent(event => { if (event.type === 'broken') throw new Error('callback failed') })
  const request = backend.sendRequest('next')
  children[0].output({ type: 'service_ready' })
  children[0].output({ type: 'broken' })
  children[0].stdout.emit('data', Buffer.from('null\n42\nnot json\n'))
  children[0].output({ request_id: children[0].messages[0].request_id, ok: true })
  assert.equal((await request).ok, true)
  assert.equal(logged.mock.callCount(), 1)
  assert.match(logged.mock.calls[0].arguments[0], /output handler failed/)
  backend.stop()
})

test('multibyte text survives arbitrary stdout chunk boundaries', async () => {
  const { backend, children } = fixture()
  const request = backend.sendRequest('unicode')
  children[0].output({ type: 'service_ready' })
  const bytes = Buffer.from(JSON.stringify({ request_id: children[0].messages[0].request_id,
    comment: '中文 日本語 🀄' }) + '\n')
  for (const byte of bytes) children[0].stdout.emit('data', Buffer.from([byte]))
  assert.equal((await request).comment, '中文 日本語 🀄')
  backend.stop()
})

test('restarting inside an event callback discards remaining lines from that process', () => {
  const { backend, children } = fixture()
  const received = []
  backend.onEvent(event => {
    received.push(event.type)
    if (event.type === 'restart-now') backend.restart()
  })
  backend.start()
  children[0].stdout.emit('data', Buffer.from('{"type":"restart-now"}\n{"type":"stale"}\n'))
  assert.deepEqual(received, ['restart-now', 'service_stopped'])
  assert.equal(children.length, 2)
  backend.stop()
})

test('startup queues requests until ready and exit rejects outstanding requests', async () => {
  const { backend, children } = fixture()
  const request = backend.sendRequest('pending')
  const rejected = assert.rejects(request, /exited before responding/)
  assert.equal(children[0].messages.length, 0)
  children[0].output({ type: 'service_ready' })
  assert.equal(children[0].messages.length, 1)
  children[0].emit('exit', 1)
  await rejected
  assert.equal(backend.isRunning(), false)
})

test('restart rejects old requests and ignores old replies, readiness and exit', async () => {
  const { backend, children, events } = fixture()
  const oldRequest = backend.sendRequest('old')
  const rejected = assert.rejects(oldRequest, /stopped before responding/)
  const old = children[0]
  old.output({ type: 'service_ready' })
  backend.restart()
  await rejected
  assert.equal(old.killed, true)
  const nextRequest = backend.sendRequest('new')
  const current = children[1]
  old.output({ type: 'service_ready' })
  old.emit('exit', 0)
  assert.equal(current.messages.length, 0)
  current.output({ type: 'service_ready' })
  const id = current.messages[0].request_id
  old.output({ request_id: id, value: 'stale' })
  current.output({ request_id: id, value: 'fresh' })
  assert.equal((await nextRequest).value, 'fresh')
  assert.deepEqual(events.map(event => event.type), ['service_ready', 'service_stopped', 'service_ready'])
  backend.stop()
})

test('stream errors reject requests and allow a clean subsequent process', async () => {
  const { backend, children } = fixture()
  const request = backend.sendRequest('first')
  const rejected = assert.rejects(request, /broken pipe/)
  children[0].stdin.emit('error', new Error('broken pipe'))
  await rejected
  assert.equal(children[0].killed, true)
  const retry = backend.sendRequest('retry')
  children[0].stdin.emit('error', new Error('late error'))
  children[1].output({ type: 'service_ready' })
  children[1].output({ request_id: children[1].messages[0].request_id, ok: true })
  assert.equal((await retry).ok, true)
  backend.stop()
})

test('synchronous and asynchronous write failures reject the owning request', async () => {
  for (const sync of [true, false]) {
    const { backend, children } = fixture()
    backend.start()
    children[0].output({ type: 'service_ready' })
    children[0].stdin.write = (_text, callback) => {
      if (sync) throw new Error('write failed')
      callback(new Error('write failed'))
    }
    await assert.rejects(backend.sendRequest('write'), /write failed/)
    backend.stop()
  }
})

test('spawn errors reject startup requests instead of leaving them queued', async () => {
  const { backend, children } = fixture()
  const request = backend.sendRequest('first')
  const rejected = assert.rejects(request, /failed to start/)
  children[0].emit('error', new Error('missing executable'))
  await rejected
  assert.equal(backend.isRunning(), false)
})

test('a stopped process notifies once and its later exit is ignored', () => {
  const { backend, children, events } = fixture()
  backend.start()
  children[0].stdin.emit('error', new Error('broken pipe'))
  children[0].emit('exit', 1)
  assert.deepEqual(events, [{ type: 'service_stopped', error: 'broken pipe' }])
  backend.start()
  children[0].emit('error', new Error('late error'))
  assert.equal(events.length, 1)
  backend.stop()
  assert.equal(events.length, 2)
})
