const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { createBackendSession } = require('./backend-session')

function fixture() {
  const calls = []
  let active = null
  let current = null
  const workspaces = {
    allocate: async () => randomUUID(), getActive: () => active,
    activate: async id => { active = id; calls.push('activate') },
    abandon: async () => {}, discardActive: async () => { active = null },
    released: async () => {}, retainClose: async () => { calls.push('retain') },
    cancelClose: async () => {}, recoverable: async () => [], updateRetention: async () => {},
    shutdown: async () => { active = null },
  }
  const backend = {
    running: true, failPrepare: false, failRestore: false,
    isRunning() { return this.running },
    async restart() { this.running = true; calls.push('restart') },
    async stop() { this.running = false },
    async sendRequest(command, payload = {}) {
      calls.push(command)
      if (command === 'create_game') current = { workspaceId: payload.workspaceId, session: randomUUID(),
        contentRevision: 1, cursorSequence: 1, savedContentRevision: 0, savedCursorSequence: 0, pathIntent: 0, savedPath: '' }
      if (command === 'record_restore') {
        if (this.failRestore) throw new Error('restore failed')
        current = { ...current, session: randomUUID() }
      }
      if (command === 'record_close_prepare' && this.failPrepare) throw new Error('durability failed')
      if (command === 'close_game') current = null
      const response = { state: { gameLoaded: Boolean(current) }, view: { currentNodeId: current ? 'branch-2' : null },
        recordRuntime: current && { ...current } }
      if (command === 'record_close_prepare') response.result = { closeId: payload.closeId, recovery: { kind: 'workspace', workspaceId: active } }
      if (command === 'record_save_capture') response.result = { ...payload, session: current.session,
        contentRevision: current.contentRevision, cursorSequence: current.cursorSequence }
      return response
    },
  }
  const session = createBackendSession(backend, { workspaces })
  return { backend, session, calls, workspaces }
}

test('restart retains a finite workspace barrier and restores by identity without whole-record snapshots', async () => {
  const { session, calls } = fixture()
  await session.sendRequest('create_game')
  calls.length = 0
  const response = await session.restart()
  assert.equal(response.ok, true)
  assert.deepEqual(calls, ['record_close_capture', 'record_close_prepare', 'restart', 'record_restore', 'record_confirm_activation'])
  assert.equal(response.view.currentNodeId, 'branch-2')
})

test('failed restart durability leaves the old process intact and unfreezes its record', async () => {
  const { backend, session, calls } = fixture()
  await session.sendRequest('create_game')
  backend.failPrepare = true
  await assert.rejects(session.restart(), /durability failed/)
  assert.equal(calls.includes('restart'), false)
  assert.equal(calls.at(-1), 'record_close_cancel')
  await session.sendRequest('set_node_comment', { nodeId: 'branch-2', comment: 'still editable' })
})

test('crash keeps the main claim and restores no data from a dead process', async () => {
  const { backend, session, calls } = fixture()
  await session.sendRequest('create_game')
  const id = session.getRuntime().workspaceId
  backend.running = false
  session.handleEvent({ type: 'service_stopped' })
  assert.equal(session.hasRecovery(), true)
  await assert.rejects(session.sendRequest('get_game_view'), /recovery/)
  calls.length = 0
  await session.restart()
  assert.deepEqual(calls, ['restart', 'record_restore', 'record_confirm_activation'])
  assert.equal(session.getRuntime().workspaceId, id)
  assert.equal(session.needsRecovery(), false)
})

test('failed restore remains retryable and never silently becomes an empty record', async () => {
  const { backend, session } = fixture()
  await session.sendRequest('create_game')
  backend.running = false
  session.handleEvent({ type: 'service_stopped' })
  backend.failRestore = true
  await assert.rejects(session.restart(), /restore failed/)
  assert.equal(session.hasRecovery(), true)
  await assert.rejects(session.sendRequest('create_game'), /recovery/)
  backend.failRestore = false
  await session.restart()
  assert.equal(session.needsRecovery(), false)
})

test('actual previous-process exit precedes private restore and duplicate restarts coalesce', async () => {
  const { backend, session, calls } = fixture()
  await session.sendRequest('create_game')
  let release
  backend.restart = () => new Promise(resolve => { release = resolve })
  const restarting = session.restart()
  assert.equal(session.restart(), restarting)
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.includes('record_restore'), false)
  release()
  await restarting
  assert.equal(calls.includes('record_restore'), true)
})

test('settled pre-crash replies cannot apply after the generation changes', async () => {
  const { backend, session } = fixture()
  let finish
  backend.sendRequest = () => new Promise(resolve => { finish = resolve })
  const request = session.sendRequest('get_game_view')
  finish({ state: { gameLoaded: true } })
  session.handleEvent({ type: 'service_stopped' })
  await assert.rejects(request, /stopped before the response/)
})

test('empty close/crash can restart empty without manufacturing a recovery record', async () => {
  const { session, calls } = fixture()
  await session.restart()
  assert.equal(calls.includes('record_restore'), false)
  await session.sendRequest('create_game')
  await session.sendRequest('close_game')
  assert.equal(session.hasRecovery(), false)
  session.handleEvent({ type: 'service_stopped' })
  const response = await session.restart()
  assert.equal(response.state.gameLoaded, false)
})

test('cancel close does not wait for its durability barrier and late prepare cannot confirm', async () => {
  const { backend, session, calls } = fixture()
  await session.sendRequest('create_game')
  let finish
  const send = backend.sendRequest.bind(backend)
  backend.sendRequest = (command, data) => command === 'record_close_prepare'
    ? new Promise(resolve => { finish = () => resolve({ result: { recovery: {} } }) }) : send(command, data)
  const preparing = session.prepareClose(true)
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
  await session.cancelClose()
  assert.equal(calls.at(-1), 'record_close_cancel')
  await session.sendRequest('set_node_comment', { nodeId: 'branch-2', comment: 'resumed' })
  finish()
  assert.equal(await preparing, null)
  await assert.rejects(session.confirmClose(), /no prepared/)
})

test('a failed main activation marker blocks old-renderer edits instead of abandoning an activated backend', async () => {
  const { session, workspaces } = fixture()
  await session.sendRequest('create_game')
  const original = workspaces.getActive()
  workspaces.activate = async () => { throw new Error('manifest disk full') }
  await assert.rejects(session.sendRequest('create_game'), /manifest disk full/)
  assert.equal(workspaces.getActive(), original)
  assert.equal(session.needsRecovery(), true)
  await assert.rejects(session.sendRequest('set_node_comment', { nodeId: 'branch-2', comment: 'stale' }), /recovery/)
})
