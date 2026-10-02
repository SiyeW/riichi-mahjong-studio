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

const root = path.resolve(__dirname, '../../..')
const python = path.join(root, '.conda-backend', process.platform === 'win32' ? 'python.exe' : 'bin/python')

test('native file import and save preserve caches and pending edits across both runtimes',
  { skip: !fs.existsSync(python), timeout: 30_000 }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-record-file-test-'))
    const env = { RMS_PORTABLE_DIR: directory, RMS_BACKEND_CONFIG: path.join(directory, 'config.json') }
    const backend = createBackendProcess({
      name: 'record-file-test', pythonExecutable: python, scriptPath: null,
      args: ['-m', 'rms_backend'], cwd: path.join(root, 'python'), env,
    })
    const session = createBackendSession(backend)
    backend.onEvent(event => session.handleEvent(event))
    try {
      const record = JSON.parse(execFileSync(python, ['-c',
        'import json; from rms_backend import service; service.STATE["game"] = service.create_empty_game(123456); service.STATE["gameLoaded"] = True; service.STATE["mode"] = "research"; print(json.dumps(service.RECORD_SESSION.serialize()))',
      ], { cwd: path.join(root, 'python'), env: { ...process.env, ...env }, encoding: 'utf8' }))
      const nodeId = record.game.currentNodeId
      const decision = { probability: 0.25, entries: [{ action: 'dahai', probability: 1 }] }
      const opponent = { outputs: { probability: 0, tiles: { '5mr': 1, '5m': 0.5 } } }
      record.game.nodes[nodeId].analysisCache = { 'm3::0::discard::source': decision }
      record.game.nodes[nodeId].opponentAnalysisCache = { 'o5::0::public::source': opponent }
      record.metadata = { recovery: { kind: 'unsaved-exit', sourcePath: 'private' } }
      const input = path.join(directory, 'input.mjstudio')
      fs.writeFileSync(input, encodeGameRecord(compactAnalysisCaches(record)))
      const imported = await session.sendRequest('import_game_record', { path: input }, null)
      assert.equal(imported.recordMetadata.recovery.kind, 'unsaved-exit')
      assert.equal(imported.state.gameLoaded, true)
      const store = createGameFileStore(directory)
      store.beginRecord({ dirty: true, nodeId })
      store.setCurrentPath(path.join(directory, 'saved.mjstudio'))
      const workflow = createRecordWorkflow({
        app: { getVersion: () => 'test' }, appOptions: {}, dialog: {}, gameFileStore: store,
        backendGateway: { exportGameRecordToFile: (filePath, options) => session.exportGameRecordToFile(filePath, options) },
        getMainWindow: () => null, t: key => key,
      })
      const editing = session.sendRequest('set_node_comment', { nodeId, comment: '评论・牌譜🀄' })
      const saved = await workflow.saveGame()
      await editing
      const decoded = decodeGameRecord(fs.readFileSync(saved.path))
      assert.equal(decoded.game.nodes[nodeId].comment, '评论・牌譜🀄')
      assert.deepEqual(decoded.game.nodes[nodeId].analysisCache['m3::0::discard::source'], decision)
      assert.deepEqual(decoded.game.nodes[nodeId].opponentAnalysisCache['o5::0::public::source'], opponent)
      assert.equal(decoded.metadata.recovery, undefined)
      assert.equal(decoded.metadata.appVersion, 'test')
      const recovery = await workflow.writeRecoveryGameRecord()
      const recoveryRecord = decodeGameRecord(fs.readFileSync(recovery.path))
      assert.deepEqual(recoveryRecord.game, decoded.game)
      assert.equal(recoveryRecord.metadata.recovery.kind, 'unsaved-exit')
      const restored = await session.sendRequest('import_game_record', { path: saved.path }, null)
      assert.equal(restored.view.currentNodeId, nodeId)
      const again = await session.sendRequest('export_game_record', {}, null)
      assert.equal(again.record.game.nodes[nodeId].comment, '评论・牌譜🀄')
      fs.writeFileSync(input, 'damaged json')
      await assert.rejects(session.sendRequest('import_game_record', { path: input }, null))
      assert.equal((await session.sendRequest('get_game_view')).view.currentNodeId, nodeId)
      assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false)
    } finally {
      backend.stop()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

test('real backend crash restores an unsaved comment and selected node from the checkpoint',
  { skip: !fs.existsSync(python), timeout: 30_000 }, async () => {
    const portableDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-recovery-test-'))
    let child
    let capture
    let stopped
    let checkpointFinished
    const captured = new Promise(resolve => { checkpointFinished = resolve })
    const backend = createBackendProcess({
      name: 'recovery-test', pythonExecutable: python,
      scriptPath: null,
      args: ['-m', 'rms_backend'],
      cwd: path.join(root, 'python'),
      env: { RMS_PORTABLE_DIR: portableDir },
      spawnProcess(...args) { child = spawn(...args); return child },
    })
    const send = backend.sendRequest
    backend.sendRequest = async (...args) => {
      const response = await send(...args)
      if (args[0] === 'export_recovery_checkpoint') checkpointFinished()
      return response
    }
    const session = createBackendSession(backend, {
      schedule(callback) { capture = callback; return 1 }, cancel() { capture = null },
    })
    backend.onEvent(event => {
      session.handleEvent(event)
      if (event.type === 'service_stopped') stopped?.()
    })
    try {
      const record = JSON.parse(execFileSync(python, ['-c',
        'import json; from rms_backend import service; service.STATE["game"] = service.create_empty_game(123456); service.STATE["gameLoaded"] = True; service.STATE["mode"] = "research"; print(json.dumps(service.RECORD_SESSION.serialize()))',
      ], { cwd: path.join(root, 'python'), env: { ...process.env, RMS_PORTABLE_DIR: portableDir }, encoding: 'utf8' }))
      const created = await session.sendRequest('import_game_record', { record })
      const node = created.view.currentNodeId
      await session.sendRequest('set_node_comment', { nodeId: node, comment: 'unsaved recovery test' })
      capture()
      await captured
      await new Promise(resolve => setImmediate(resolve))
      const exited = new Promise(resolve => { stopped = resolve })
      child.kill()
      await exited
      const restored = await session.restart()
      assert.equal(restored.state.gameLoaded, true)
      assert.equal(restored.view.currentNodeId, node)
      const exported = await session.sendRequest('export_game_record')
      assert.equal(JSON.stringify(exported.record).includes('unsaved recovery test'), true)
      await session.sendRequest('close_game')
      assert.equal(session.hasCheckpoint(), false)
      const emptyExited = new Promise(resolve => { stopped = resolve })
      child.kill()
      await emptyExited
      const empty = await session.restart()
      assert.equal(empty.state.gameLoaded, false)
      assert.equal(empty.view.currentNodeId, null)
      const reopened = await session.sendRequest('import_game_record', { record })
      assert.equal(reopened.state.gameLoaded, true)
    } finally {
      backend.stop()
      // This directory was created by this test, never the user's portable data.
      fs.rmSync(portableDir, { recursive: true, force: true })
    }
  })
