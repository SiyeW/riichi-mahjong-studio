const test = require('node:test')
const assert = require('node:assert/strict')
const { createSessionCheckpoint } = require('./session-checkpoint')
const turn = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  const timers = new Map()
  const requests = []
  const errors = []
  let id = 0
  const checkpoint = createSessionCheckpoint({
    schedule(callback) { timers.set(++id, callback); return id },
    cancel(id) { timers.delete(id) },
    isRunning: () => true,
    exportRecord: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    onError: (...args) => errors.push(args),
  })
  function fire() {
    for (const [key, callback] of [...timers]) { timers.delete(key); callback() }
  }
  const response = gameId => ({ state: { gameLoaded: true }, view: { gameId }, record: { game: { gameId } } })
  checkpoint.observe(response('a'))
  return { checkpoint, timers, requests, errors, fire, response }
}

test('many changes share one timer and exports never overlap', async () => {
  const f = fixture()
  for (let i = 0; i < 20; i++) f.checkpoint.changed()
  assert.equal(f.timers.size, 1)
  f.fire()
  f.checkpoint.changed()
  assert.equal(f.timers.size, 0)
  assert.equal(f.requests.length, 1)
  f.requests[0].resolve(f.response('a'))
  await turn()
  assert.equal(f.timers.size, 1)
  assert.equal(f.checkpoint.get().record.game.gameId, 'a')
  f.checkpoint.stop()
})

test('switching games clears the old checkpoint and ignores its delayed export', async () => {
  const f = fixture()
  f.checkpoint.changed(); f.fire()
  f.checkpoint.observe(f.response('b'))
  f.checkpoint.changed()
  f.requests[0].resolve(f.response('a'))
  await turn()
  assert.equal(f.checkpoint.get(), null)
  f.fire()
  f.requests[1].resolve(f.response('b'))
  await turn()
  assert.equal(f.checkpoint.get().record.game.gameId, 'b')
})

test('closing the game clears the checkpoint and scheduled export', async () => {
  const f = fixture()
  f.checkpoint.changed(); f.fire()
  f.requests[0].resolve(f.response('a'))
  await turn()
  f.checkpoint.changed()
  f.checkpoint.observe({ state: { gameLoaded: false } })
  assert.equal(f.checkpoint.get(), null)
  assert.equal(f.timers.size, 0)
})

test('process stop keeps the last complete checkpoint, not an in-flight result', async () => {
  const f = fixture()
  f.checkpoint.changed(); f.fire()
  f.requests[0].resolve(f.response('a'))
  await turn()
  const saved = f.checkpoint.get()
  f.checkpoint.changed(); f.fire()
  f.checkpoint.stop()
  f.requests[1].resolve(f.response('a'))
  await turn()
  assert.equal(f.checkpoint.get(), saved)
  assert.equal(f.timers.size, 0)
})

test('export failure keeps the last checkpoint and does not spin retrying', async () => {
  const f = fixture()
  f.checkpoint.changed(); f.fire()
  f.requests[0].resolve(f.response('a'))
  await turn()
  const saved = f.checkpoint.get()
  f.checkpoint.changed(); f.fire()
  f.requests[1].reject(new Error('export failed'))
  await turn()
  assert.equal(f.checkpoint.get(), saved)
  assert.equal(f.errors.length, 1)
  assert.equal(f.timers.size, 0)
})
