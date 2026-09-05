const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { createBackendProcess } = require('./backend-process')
const { createBackendSession } = require('./backend-session')

const root = path.resolve(__dirname, '../../..')
const python = path.join(root, '.conda-backend', process.platform === 'win32' ? 'python.exe' : 'bin/python')

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
      scriptPath: path.join(root, 'python/environment/service.py'),
      cwd: path.join(root, 'python/environment'),
      env: { MJAI_TRAINER_PORTABLE_DIR: portableDir },
      spawnProcess(...args) { child = spawn(...args); return child },
    })
    const send = backend.sendRequest
    backend.sendRequest = async (...args) => {
      const response = await send(...args)
      if (args[0] === 'export_game_record') checkpointFinished()
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
        'import json, service; service.STATE["game"] = service.create_empty_game(123456); service.STATE["gameLoaded"] = True; service.STATE["mode"] = "research"; print(json.dumps(service.serialize_game_record()))',
      ], { cwd: path.join(root, 'python/environment'), env: { ...process.env, MJAI_TRAINER_PORTABLE_DIR: portableDir }, encoding: 'utf8' }))
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
    } finally {
      backend.stop()
      // This directory was created by this test, never the user's portable data.
      fs.rmSync(portableDir, { recursive: true, force: true })
    }
  })
