const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendSession } = require('./backend-session')

function fixture(loaded = true, checkpointOptions = {}) {
  const calls = []
  const record = { game: { gameId: 'game-a', currentNodeId: 'branch-2', nodes: { 'branch-2': { comment: 'unsaved' } } } }
  const backend = {
    loaded,
    running: true,
    isRunning() { return this.running },
    restart() { this.running = true; calls.push('restart') },
    async sendRequest(command, payload) {
      calls.push(command)
      if (command === 'export_game_record') return { record, state: { analysisVisibility: { opponentAnalysis: true } } }
      if (command === 'import_game_record') {
        assert.deepEqual(payload.record, record)
        if (backend.failImport) throw new Error('import failed')
      }
      return { state: { gameLoaded: backend.loaded, analysisVisibility: { opponentAnalysis: true } }, view: { gameId: 'game-a', currentNodeId: 'branch-2' } }
    },
  }
  return { backend, session: createBackendSession(backend, checkpointOptions), calls }
}

test('restart exports before stopping and returns only after restoration and visibility sync', async () => {
  const { session, calls } = fixture()
  const result = await session.restart()
  assert.equal(result.ok, true)
  assert.equal(result.view.currentNodeId, 'branch-2')
  assert.deepEqual(calls, ['get_status', 'export_game_record', 'restart', 'import_game_record', 'set_analysis_visibility', 'get_game_view'])
})

test('restart waits for outstanding edits, rejects new operations and coalesces duplicate restarts', async () => {
  const { backend, session, calls } = fixture()
  const send = backend.sendRequest
  let finish
  backend.sendRequest = (command, payload) => command === 'edit'
    ? new Promise(resolve => { finish = resolve }) : send(command, payload)
  const edit = session.sendRequest('edit')
  const restart = session.restart()
  assert.equal(session.restart(), restart)
  await assert.rejects(session.sendRequest('create_game'), /recovery/)
  assert.deepEqual(calls, [])
  finish({})
  await edit
  await restart
})

test('export failure leaves the original process intact', async () => {
  const { backend, session, calls } = fixture()
  const send = backend.sendRequest
  backend.sendRequest = async (command, payload) => {
    if (command === 'export_game_record') throw new Error('export failed')
    return send(command, payload)
  }
  await assert.rejects(session.restart(), /export failed/)
  assert.equal(calls.includes('restart'), false)
  await session.sendRequest('get_status')
})

test('failed import retains its snapshot for retry and blocks replacement games', async () => {
  const { backend, session, calls } = fixture()
  backend.failImport = true
  await assert.rejects(session.restart(), /import failed/)
  await assert.rejects(session.sendRequest('create_game'), /recovery/)
  backend.failImport = false
  await session.restart()
  assert.equal(calls.filter(call => call === 'export_game_record').length, 1)
  await session.sendRequest('get_status')
})

test('an empty session restarts without trying to export a game', async () => {
  const { session, calls } = fixture(false)
  await session.restart()
  assert.equal(calls.includes('export_game_record'), false)
  assert.equal(calls.includes('import_game_record'), false)
})

test('a stopped session without a snapshot can restart empty, then accept requests', async () => {
  const { backend, session, calls } = fixture(false)
  backend.running = false
  session.handleEvent({ type: 'service_stopped' })
  assert.equal(session.hasCheckpoint(), false)
  const result = await session.restart()
  assert.equal(result.state.gameLoaded, false)
  assert.equal(calls.includes('export_game_record'), false)
  assert.equal(calls.includes('import_game_record'), false)
  await session.sendRequest('get_status')
  assert.equal(session.needsRecovery(), false)
})

test('an empty response after import is not a successful recovery', async () => {
  const { backend, session } = fixture()
  const send = backend.sendRequest
  backend.sendRequest = (command, payload) => command === 'get_game_view'
    ? Promise.resolve({ state: { gameLoaded: false }, view: {} }) : send(command, payload)
  await assert.rejects(session.restart(), /did not confirm/)
  await assert.rejects(session.sendRequest('create_game'), /recovery/)
})

test('a final reply followed by backend exit cannot mark recovery successful', async () => {
  const { backend, session } = fixture()
  const send = backend.sendRequest
  backend.sendRequest = async (command, payload) => {
    const response = await send(command, payload)
    if (command === 'get_game_view') {
      backend.running = false
      session.handleEvent({ type: 'service_stopped' })
    }
    return response
  }
  await assert.rejects(session.restart(), /stopped during recovery/)
  assert.equal(session.needsRecovery(), true)
  assert.equal(session.hasCheckpoint(), true)
  backend.sendRequest = send
  await session.restart()
  assert.equal(session.needsRecovery(), false)
})

test('a crash restores the latest completed checkpoint without exporting from the dead process', async () => {
  let capture
  const { backend, session, calls } = fixture(true, { schedule(callback) { capture = callback; return 1 }, cancel() {} })
  await session.sendRequest('create_game')
  capture()
  await new Promise(resolve => setImmediate(resolve))
  backend.running = false
  session.handleEvent({ type: 'service_stopped' })
  await assert.rejects(session.sendRequest('get_status'), /recovery/)
  assert.equal(session.needsRecovery(), true)
  const exports = calls.filter(call => call === 'export_game_record').length
  await session.restart()
  assert.equal(calls.filter(call => call === 'export_game_record').length, exports)
  assert.equal(session.needsRecovery(), false)
})

test('a settled response from before the stop is rejected before applying its state', async () => {
  const { backend, session } = fixture()
  let finish
  backend.sendRequest = () => new Promise(resolve => { finish = resolve })
  const request = session.sendRequest('get_game_view')
  finish({ state: { gameLoaded: true }, view: { gameId: 'game-a' } })
  session.handleEvent({ type: 'service_stopped' })
  await assert.rejects(request, /stopped before the response/)
})

test('reimporting a record with the same game ID cannot recover its predecessor', async () => {
  let capture
  const { backend, session } = fixture(true, { schedule(callback) { capture = callback; return 1 }, cancel() {} })
  await session.sendRequest('create_game')
  capture()
  await new Promise(resolve => setImmediate(resolve))
  await session.sendRequest('create_game')
  backend.running = false
  session.handleEvent({ type: 'service_stopped' })
  assert.equal(session.hasCheckpoint(), false)
  backend.loaded = false
  await session.restart()
})
