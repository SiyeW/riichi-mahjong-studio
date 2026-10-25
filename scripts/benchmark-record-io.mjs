import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'

const require = createRequire(import.meta.url)
const { createBackendProcess } = require('../electron/main/services/backend-process')
const { createBackendSession } = require('../electron/main/services/backend-session')
const { createRecordWorkflow } = require('../electron/main/services/record-workflow')
const { createGameFileStore } = require('../electron/main/state/game-file-store')
const root = path.resolve(import.meta.dirname, '..')
const input = path.resolve(process.argv[2] || path.join(root, 'examples/example-record.mjstudio'))
const executable = process.argv[3] && path.resolve(process.argv[3])
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rms-record-benchmark-'))
const stages = []
let analysisEvents = 0
const backend = createBackendProcess({ name: 'record-benchmark',
  pythonExecutable: executable || path.join(root, '.conda-backend', process.platform === 'win32' ? 'python.exe' : 'bin/python'),
  scriptPath: null, args: executable ? [] : ['-m', 'rms_backend'],
  cwd: executable ? path.dirname(executable) : path.join(root, 'python'),
  env: { RMS_PORTABLE_DIR: directory, RMS_BACKEND_CONFIG: path.join(directory, 'config.json') },
})
const session = createBackendSession(backend, { workspaceRoot: path.join(directory, 'records/.recovery/workspaces') })
backend.onEvent(event => {
  session.handleEvent(event)
  if (['analysis_ready', 'opponent_analysis_ready'].includes(event.type)) analysisEvents++
})
const store = createGameFileStore(directory)
const workflow = createRecordWorkflow({ app: { getVersion: () => 'benchmark' }, appOptions: {}, dialog: {},
  gameFileStore: store, getMainWindow: () => null, t: key => key,
  backendGateway: { captureRecordSave: session.captureSave, writeRecordSave: session.writeSave,
    acknowledgeRecordSave: session.acknowledgeSave, abortRecordSave: session.abortSave,
    releaseRecordSave: session.releaseSave,
    getRecordRuntime: session.getRuntime },
})

async function timed(name, task) {
  const start = performance.now()
  const result = await task()
  const ms = Math.round(performance.now() - start)
  stages.push({ name, ms })
  console.log(JSON.stringify({ stage: name, ms }))
  return result
}

try {
  await timed('service-start', () => session.sendRequest('get_status'))
  await session.sendRequest('set_analysis_visibility', { decisionRecommendations: true, opponentAnalysis: true })
  let opened = await timed('source-open', () => session.sendRequest('import_game_record', { path: input }))
  store.beginRecord({ dirty: false, nodeId: opened.view.currentNodeId })
  const output = path.join(directory, 'saved.mjstudio')
  store.setCurrentPath(output)
  const nodeIds = opened.view.tree.nodes.map(node => node.id)
  const visitIds = [...nodeIds.slice(0, 16), ...nodeIds.slice(0, 16).reverse(),
    ...Array.from({ length: 12 }, (_, i) => nodeIds[Math.floor(i * (nodeIds.length - 1) / 11)])]
  const timings = []
  let intent = 0
  await timed('browse-adjacent-reverse-jump', async () => {
    for (const nodeId of visitIds) {
      const start = performance.now()
      opened = await session.sendRequest('jump_to_node', { nodeId, treeRevision: opened.view.tree.revision,
        navigationIntent: ++intent })
      timings.push(performance.now() - start)
    }
  })
  await timed('first-portable-save', () => workflow.saveGame())
  const savedSize = (await fs.stat(output)).size
  await timed('repeat-portable-save', () => workflow.saveGame())
  await timed('comment-edit', () => session.sendRequest('set_node_comment', {
    nodeId: opened.view.currentNodeId, comment: 'Benchmark edit — 牌譜' }))
  await timed('edited-portable-save', () => workflow.saveGame())
  await timed('native-open', () => session.sendRequest('import_game_record', { path: output }))
  await timed('native-repeat-save', () => workflow.saveGame())
  const prepared = await timed('clean-close-prepare', () => session.prepareClose(true))
  assert.equal(prepared.recovery.kind, 'source')
  await timed('clean-close-confirm', () => session.confirmClose())
  const metrics = await session.sendRequest('get_runtime_metrics')
  timings.sort((a, b) => a - b)
  console.log(JSON.stringify({ result: { nodes: nodeIds.length, inputBytes: (await fs.stat(input)).size,
    outputBytes: savedSize, analysisEvents, stages,
    navigation: { samples: timings.length, medianMs: timings[Math.floor(timings.length / 2)],
      p95Ms: timings[Math.floor(timings.length * .95)], maxMs: timings.at(-1) },
    memory: metrics.metrics } }))
} finally {
  await session.shutdown()
  await fs.rm(directory, { recursive: true, force: true })
}
