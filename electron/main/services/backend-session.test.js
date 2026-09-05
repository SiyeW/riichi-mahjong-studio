const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendSession } = require('./backend-session')

function fixture(loaded = true) {
  const calls = []
  const record = { game: { currentNodeId: 'branch-2', nodes: { 'branch-2': { comment: 'unsaved' } } } }
  const backend = {
    running: true,
    isRunning() { return this.running },
    restart() { calls.push('restart') },
    async sendRequest(command, payload) {
      calls.push(command)
      if (command === 'export_game_record') return { record }
      if (command === 'import_game_record') {
        assert.deepEqual(payload.record, record)
        if (backend.failImport) throw new Error('import failed')
      }
      return { state: { gameLoaded: loaded, analysisVisibility: { opponentAnalysis: true } }, view: { currentNodeId: 'branch-2' } }
    },
  }
  return { backend, session: createBackendSession(backend), calls }
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

test('a crashed process cannot be replaced under the guise of taking a snapshot', async () => {
  const { backend, session, calls } = fixture()
  backend.running = false
  await assert.rejects(session.restart(), /no restart snapshot/)
  assert.deepEqual(calls, [])
})

test('an empty response after import is not a successful recovery', async () => {
  const { backend, session } = fixture()
  const send = backend.sendRequest
  backend.sendRequest = (command, payload) => command === 'get_game_view'
    ? Promise.resolve({ state: { gameLoaded: false }, view: {} }) : send(command, payload)
  await assert.rejects(session.restart(), /did not confirm/)
  await assert.rejects(session.sendRequest('create_game'), /recovery/)
})
