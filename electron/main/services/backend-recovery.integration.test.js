const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { createBackendProcess } = require('./backend-process')
const { createBackendSession } = require('./backend-session')
const { createRecordWorkflow } = require('./record-workflow')
const { createGameFileStore } = require('../state/game-file-store')
const { encodeGameRecord, decodeGameRecord } = require('../state/game-record-codec')
const { compactAnalysisCaches } = require('../state/analysis-cache-storage')
const { loadSettings, saveSettings } = require('../state/settings')

const root = path.resolve(__dirname, '../../..')
const python = path.join(root, '.conda-backend', process.platform === 'win32' ? 'python.exe' : 'bin/python')
const packagedBackend = process.env.RMS_TEST_BACKEND_EXECUTABLE || null
const supported = { skip: !fs.existsSync(python), timeout: 60_000 }
const cleanupOwners = new WeakMap()

function runtime(context, directory) {
  let owners = cleanupOwners.get(context)
  if (!owners) {
    owners = { sessions: [], directories: [] }
    cleanupOwners.set(context, owners)
    context.after(async () => {
      for (const session of owners.sessions.reverse()) await session.shutdown()
      for (const folder of owners.directories) fs.rmSync(folder, { recursive: true, force: true })
    })
  }
  if (!directory) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-incremental-record-'))
    owners.directories.push(directory)
  }
  let child
  const backend = createBackendProcess({ name: 'record-integration', pythonExecutable: packagedBackend || python,
    scriptPath: null, args: packagedBackend ? [] : ['-m', 'rms_backend'],
    cwd: packagedBackend ? path.dirname(packagedBackend) : path.join(root, 'python'),
    env: { RMS_PORTABLE_DIR: directory, RMS_BACKEND_CONFIG: path.join(directory, 'config.json') },
    spawnProcess(...args) { child = spawn(...args); return child },
  })
  const session = createBackendSession(backend, { workspaceRoot: path.join(directory, 'records', '.recovery', 'workspaces') })
  backend.onEvent(session.handleEvent)
  owners.sessions.push(session)
  const store = createGameFileStore(directory)
  const workflow = createRecordWorkflow({ app: { getVersion: () => 'test' }, appOptions: {}, dialog: {}, gameFileStore: store,
    backendGateway: { captureRecordSave: session.captureSave, writeRecordSave: session.writeSave,
      acknowledgeRecordSave: session.acknowledgeSave, abortRecordSave: session.abortSave,
      getRecordRuntime: session.getRuntime }, getMainWindow: () => null, t: key => key })
  return { directory, backend, session, store, workflow, child: () => child }
}

function recordFixture(directory) {
  return JSON.parse(execFileSync(python, ['-c',
    'import json; from rms_backend import service; service.STATE["game"] = service.create_empty_game(123456); service.STATE["gameLoaded"] = True; service.STATE["mode"] = "research"; print(json.dumps(service.RECORD_SESSION.serialize()))',
  ], { cwd: path.join(root, 'python'), env: { ...process.env, RMS_PORTABLE_DIR: directory,
    RMS_BACKEND_CONFIG: path.join(directory, 'config.json') }, encoding: 'utf8' }))
}

test('native import, authored edit and V2 save preserve real action/analysis facts across runtimes', supported, async context => {
  const { directory, session, store, workflow } = runtime(context)
  const record = recordFixture(directory)
  const nodeId = record.game.currentNodeId
  const decision = { probability: 0.25, entries: [{ action: 'dahai', probability: 1 }] }
  const opponent = { outputs: { probability: 0, tiles: { '5mr': 1, '5m': 0.5 } } }
  record.game.nodes[nodeId].analysisCache = { 'm3::0::discard::source': decision }
  record.game.nodes[nodeId].opponentAnalysisCache = { 'o5::0::public::source': opponent }
  const input = path.join(directory, 'input.mjstudio')
  fs.writeFileSync(input, encodeGameRecord(compactAnalysisCaches(record)))
  const imported = await session.sendRequest('import_game_record', { path: input })
  assert.equal(imported.state.gameLoaded, true)
  store.beginRecord({ dirty: false, nodeId })
  const target = path.join(directory, 'saved.mjstudio')
  store.setCurrentPath(target)
  const edit = session.sendRequest('set_node_comment', { nodeId, comment: '评论・牌譜🀄' })
  const saved = await workflow.saveGame()
  await edit
  const bytes = fs.readFileSync(saved.path)
  assert.equal(bytes.subarray(0, 8).toString(), 'MJSTBLK2')
  const decoded = decodeGameRecord(bytes)
  assert.equal(decoded.game.nodes[nodeId].comment, '评论・牌譜🀄')
  assert.deepEqual(decoded.game.nodes[nodeId].analysisCache['m3::0::discard::source'], decision)
  assert.deepEqual(decoded.game.nodes[nodeId].opponentAnalysisCache['o5::0::public::source'], opponent)
  assert.equal(saved.recordDirty, false)
  assert.equal(decoded.metadata.appVersion, 'test')
  fs.writeFileSync(input, 'damaged json')
  await assert.rejects(session.sendRequest('import_game_record', { path: input }))
  assert.equal((await session.sendRequest('get_game_view')).view.currentNodeId, nodeId)
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false)
})

test('a main claim survives real backend death; another instance cannot steal it and restart restores durable edits', supported, async context => {
  const first = runtime(context)
  const created = await first.session.sendRequest('import_game_record', { record: recordFixture(first.directory) })
  const nodeId = created.view.currentNodeId
  const identity = first.session.getRuntime().workspaceId
  await first.session.sendRequest('set_node_comment', { nodeId, comment: 'durable unsaved comment' })
  await first.session.sendRequest('record_flush', { workspaceId: identity })
  const second = runtime(context, first.directory)
  assert.equal(await second.session.restoreStartup(), null)
  const child = first.child()
  const exited = new Promise(resolve => child.once('close', resolve))
  child.kill()
  await exited
  assert.equal(first.session.needsRecovery(), true)
  assert.equal(await second.session.restoreStartup(), null)
  const restored = await first.session.restart()
  assert.equal(restored.view.nodeComment, 'durable unsaved comment')
  assert.equal(restored.view.currentNodeId, nodeId)
  assert.equal(first.session.getRuntime().workspaceId, identity)
  const oldScope = first.session.getRuntime().session
  await first.session.sendRequest('import_game_record', { record: recordFixture(first.directory) })
  await assert.rejects(first.backend.sendRequest('set_node_comment', { nodeId, comment: 'stale', recordScope: oldScope }), /SCOPE_CHANGED/)
})

test('dirty exit retains incremental workspace and a new main restores it without a portable exit snapshot', supported, async context => {
  const first = runtime(context)
  const created = await first.session.sendRequest('import_game_record', { record: recordFixture(first.directory) })
  await first.session.sendRequest('set_node_comment', { nodeId: created.view.currentNodeId, comment: 'exit recovery' })
  const prepared = await first.session.prepareClose(true)
  assert.equal(prepared.recovery.kind, 'workspace')
  await first.session.confirmClose()
  await first.session.shutdown()
  assert.equal(fs.existsSync(first.store.getRecoveryPath()), false)
  const second = runtime(context, first.directory)
  const restored = await second.session.restoreStartup()
  assert.equal(restored.view.nodeComment, 'exit recovery')
  assert.equal(restored.state.gameLoaded, true)
})

test('clean exit restores the saved source plus current bookmark and retention-off does not return it', supported, async context => {
  const first = runtime(context)
  const created = await first.session.sendRequest('import_game_record', { record: recordFixture(first.directory) })
  first.store.beginRecord({ dirty: true, nodeId: created.view.currentNodeId })
  first.store.setCurrentPath(path.join(first.directory, 'clean.mjstudio'))
  await first.workflow.saveGame()
  await first.session.sendRequest('toggle_visible_hands')
  const prepared = await first.session.prepareClose(true)
  assert.equal(prepared.recovery.kind, 'source')
  assert.equal(prepared.recovery.bookmark.visibleHands, true)
  await first.session.confirmClose()
  await first.session.shutdown()
  const second = runtime(context, first.directory)
  const restored = await second.session.restoreStartup()
  assert.equal(restored.state.visibleHands, true)
  assert.equal(restored.view.currentNodeId, created.view.currentNodeId)
  const disabled = await second.session.prepareClose(false)
  assert.equal(disabled.recovery, null)
  await second.session.confirmClose()
  await second.session.shutdown()
  const third = runtime(context, first.directory)
  assert.equal(await third.session.restoreStartup(), null)
})

test('a promoted save with a lost ACK reconciles its exact intent after real backend death', supported, async context => {
  const first = runtime(context)
  await first.session.sendRequest('import_game_record', { record: recordFixture(first.directory) })
  const target = path.join(first.directory, 'lost-ack.mjstudio')
  const token = await first.session.captureSave(target, 'test')
  const stage = `${target}.${token.saveId}.tmp`
  await first.session.writeSave(token, stage)
  fs.renameSync(stage, target)
  const child = first.child()
  const exited = new Promise(resolve => child.once('close', resolve))
  child.kill()
  await exited
  const restored = await first.session.restart()
  assert.deepEqual(restored.saveReconciliationErrors, [])
  assert.equal(first.session.getRuntime().savedPath, target)
  assert.equal(first.session.getRuntime().savedContentRevision, token.contentRevision)
  const prepared = await first.session.prepareClose(true)
  assert.equal(prepared.recovery.kind, 'source')
  assert.equal(prepared.recovery.path, target)
  await first.session.cancelClose()
})

test('queued frontend scopes reject old sessions and implicit actions in superseded visits', supported, async context => {
  const first = runtime(context)
  const record = recordFixture(first.directory)
  const created = await first.session.sendRequest('import_game_record', { record })
  const scope = created.view.viewToken
  await first.session.sendRequest('jump_to_node', { nodeId: created.view.currentNodeId, navigationIntent: 2 })
  await assert.rejects(first.session.sendRequest('advance_game', { recordViewScope: scope }), /SCOPE_CHANGED/)
  // Explicit comment edits remain valid after browsing within their own record.
  await first.session.sendRequest('set_node_comment', { nodeId: created.view.currentNodeId, comment: 'valid', recordViewScope: scope })
  await first.session.sendRequest('import_game_record', { record })
  await assert.rejects(first.session.sendRequest('set_node_comment', { nodeId: created.view.currentNodeId,
    comment: 'old queued edit', recordViewScope: scope }), /SCOPE_CHANGED/)
  assert.notEqual((await first.session.sendRequest('get_game_view')).view.nodeComment, 'old queued edit')
})

test('cache preference applies live and survives exit, new backend and reread from its actual config', supported, async context => {
  const first = runtime(context)
  const options = { portableDir: first.directory,
    env: { RMS_BACKEND_CONFIG: path.join(first.directory, 'config.json') } }
  const settings = loadSettings(options)
  settings.records.analysisCacheMiB = 64
  saveSettings(settings, options)
  await first.session.sendRequest('import_game_record', { record: recordFixture(first.directory) })
  let metrics = await first.session.sendRequest('get_runtime_metrics')
  assert.equal(metrics.metrics.recordCache.budgetBytes, 64 * 1024 * 1024)
  settings.records.analysisCacheMiB = 1
  saveSettings(settings, options)
  await first.session.sendRequest('record_preferences', settings.records)
  metrics = await first.session.sendRequest('get_runtime_metrics')
  assert.equal(metrics.metrics.recordCache.budgetBytes, 1024 * 1024)
  await first.session.prepareClose(true)
  await first.session.confirmClose()
  await first.session.shutdown()
  const second = runtime(context, first.directory)
  await second.session.restoreStartup()
  metrics = await second.session.sendRequest('get_runtime_metrics')
  assert.equal(metrics.metrics.recordCache.budgetBytes, 1024 * 1024)
  assert.equal(loadSettings(options).records.analysisCacheMiB, 1)
})
