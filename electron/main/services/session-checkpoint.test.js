const test = require('node:test')
const assert = require('node:assert/strict')
const { createSessionCheckpoint } = require('./session-checkpoint')
const turn = () => new Promise(resolve => setImmediate(resolve))

test('slow exports increase the next wait instead of exporting continuously', async () => {
  let time = 0
  let callback
  let wait
  const checkpoint = createSessionCheckpoint({
    now: () => time, isRunning: () => true,
    schedule(fn, ms) { callback = fn; wait = ms; return 1 }, cancel() {},
    exportRecord: async () => { time += 1500; return { record: { game: { gameId: 'a' } } } },
  })
  checkpoint.observe({ view: { gameId: 'a' } })
  checkpoint.changed()
  assert.equal(wait, 750)
  callback()
  await turn()
  checkpoint.changed()
  assert.equal(wait, 6000)
  checkpoint.stop()
})

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

test('cursor and visibility changes patch the completed snapshot without another export', async () => {
  const f = fixture()
  f.checkpoint.changed()
  f.fire()
  f.requests[0].resolve({
    state: { gameLoaded: true },
    view: { gameId: 'a' },
    record: { game: { gameId: 'a', currentNodeId: 'n1', pendingReview: { nodeId: 'n1' }, nodes: { n1: {}, n2: {} } } },
  })
  await turn()

  assert.equal(f.checkpoint.moveCursor('n2'), true)
  assert.equal(f.checkpoint.updateVisibility({ opponentAnalysis: true }), true)
  assert.equal(f.checkpoint.get().record.game.currentNodeId, 'n2')
  assert.equal(f.checkpoint.get().record.game.pendingReview, null)
  assert.deepEqual(f.checkpoint.get().visibility, { opponentAnalysis: true })
  assert.equal(f.timers.size, 0)
})

test('only a settled checkpoint without pending changes is reusable', async () => {
  const f = fixture()
  assert.equal(f.checkpoint.getFresh(), null)

  f.checkpoint.changed()
  assert.equal(f.checkpoint.getFresh(), null)
  f.fire()
  f.requests[0].resolve(f.response('a'))
  await turn()
  assert.equal(f.checkpoint.getFresh(), f.checkpoint.get())

  f.checkpoint.changed()
  assert.equal(f.checkpoint.getFresh(), null)
})

test('a foreground export supersedes scheduled and in-flight checkpoints', async () => {
  const f = fixture()
  f.checkpoint.changed()
  f.fire()
  const foreground = { record: { game: { gameId: 'a', currentNodeId: 'new' } }, visibility: { opponentAnalysis: true } }
  assert.equal(f.checkpoint.rememberFresh(foreground), true)
  assert.equal(f.checkpoint.getFresh(), null, 'the older in-flight export must settle before reuse')

  f.requests[0].resolve(f.response('a'))
  await turn()
  assert.equal(f.checkpoint.getFresh(), foreground)
  assert.equal(f.checkpoint.get().record.game.currentNodeId, 'new')
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
