import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

const host = '127.0.0.1'
const port = Number(process.env.RMS_RENDERER_PORT || 5173)
const url = `http://${host}:${port}`
const root = path.resolve(import.meta.dirname, '..')
const viteEntry = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const sessionDirectory = path.resolve(
  process.env.RMS_RENDERER_SESSION_DIR
    || path.join(root, 'node_modules', '.cache', 'rms-debug-renderer'),
)
const sessionPath = path.join(sessionDirectory, 'session.json')
const stopPath = path.join(sessionDirectory, 'stop.json')
const checkOnly = process.argv.includes('--check')
const stopOnly = process.argv.includes('--stop')

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function fetchText(pathname) {
  return new Promise((resolve) => {
    const request = http.get({ host, port, path: pathname, timeout: 1000 }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode || 0, body }))
    })
    request.on('error', () => resolve(null))
    request.on('timeout', () => {
      request.destroy()
      resolve(null)
    })
  })
}

async function probeRenderer() {
  const page = await fetchText('/')
  if (!page) return 'available'
  const isRmsPage = page.status === 200
    && page.body.includes('<title>Riichi Mahjong Studio</title>')
    && page.body.includes('src="/src/main.ts')
  if (!isRmsPage) return 'occupied'
  const client = await fetchText('/@vite/client')
  const source = await fetchText('/src/main.ts')
  const isRmsRenderer = client?.status === 200
    && source?.status === 200
    && source.body.includes('import App from "/src/App.vue')
  return isRmsRenderer ? 'ready' : 'starting'
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(filePath, value) {
  mkdirSync(sessionDirectory, { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, 'utf8')
  renameSync(temporaryPath, filePath)
}

function removeFile(filePath) {
  rmSync(filePath, { force: true })
}

function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function matchingSession(value) {
  return value
    && value.version === 1
    && path.resolve(value.root || '') === root
    && value.host === host
    && value.port === port
    && typeof value.token === 'string'
}

function terminateProcessTree(pid) {
  if (!isRunning(pid)) return true
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return result.status === 0 || !isRunning(pid)
  }
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    // The process may have exited between the liveness check and the signal.
    return !isRunning(pid)
  }
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await delay(100)
  }
  return false
}

async function requestRendererStop() {
  const session = readJson(sessionPath)
  if (!matchingSession(session)) {
    console.log(`RMS_RENDERER_STOPPED ${url} (no managed session)`)
    return
  }

  writeJson(stopPath, { token: session.token })
  const stopped = await waitUntil(() => {
    const current = readJson(sessionPath)
    return !current || current.token !== session.token
  }, 8_000)
  if (!stopped) {
    console.error(`Error: RMS renderer supervisor did not stop at ${url}.`)
    process.exitCode = 1
    return
  }

  if (session.rendererPid) {
    const released = await waitUntil(async () => await probeRenderer() === 'available', 5_000)
    if (!released) {
      console.error(`Error: RMS renderer did not release ${url}.`)
      process.exitCode = 1
      return
    }
  }
  console.log(`RMS_RENDERER_STOPPED ${url}`)
}

async function stopPreviousSupervisor(session) {
  if (!matchingSession(session)
    || !isRunning(session.supervisorPid)
    || session.supervisorPid === process.pid) return true

  writeJson(stopPath, { token: session.token })
  return await waitUntil(() => {
    const current = readJson(sessionPath)
    return !current || current.token !== session.token
  }, 8_000)
}

if (stopOnly) {
  await requestRendererStop()
  process.exit(process.exitCode || 0)
}

async function waitForRenderer(child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await probeRenderer()
    if (state === 'ready') return true
    if (state === 'occupied' || child.exitCode !== null) return false
    await delay(150)
  }
  return false
}

const token = randomUUID()
let ownedRenderer = null
let managedRendererPid = null
let stopping = false

function publishSession(rendererPid) {
  managedRendererPid = rendererPid
  writeJson(sessionPath, {
    version: 1,
    token,
    root,
    host,
    port,
    supervisorPid: process.pid,
    rendererPid,
  })
}

function stopRequested() {
  return readJson(stopPath)?.token === token
}

function requestLocalStop() {
  stopping = true
}

async function stopManagedRenderer() {
  const pid = managedRendererPid
  if (!pid) return true
  if (ownedRenderer?.pid === pid && ownedRenderer.exitCode === null) {
    ownedRenderer.kill('SIGTERM')
    await waitUntil(() => ownedRenderer?.exitCode !== null || !isRunning(pid), 3_000)
  }
  if (isRunning(pid)) terminateProcessTree(pid)
  const stopped = await waitUntil(() => !isRunning(pid), 3_000)
  if (stopped) {
    managedRendererPid = null
    ownedRenderer = null
  }
  return stopped
}

process.once('SIGINT', requestLocalStop)
process.once('SIGTERM', requestLocalStop)
process.once('exit', () => {
  if (ownedRenderer?.exitCode === null) terminateProcessTree(ownedRenderer.pid)
})

async function startRenderer() {
  const child = spawn(process.execPath, [
    viteEntry,
    '--host', host,
    '--port', String(port),
    '--strictPort',
  ], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  ownedRenderer = child
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  publishSession(child.pid)
  if (await waitForRenderer(child)) return true

  // Another task may have won the strict-port race while this child started.
  if (await probeRenderer() === 'ready') {
    terminateProcessTree(child.pid)
    if (ownedRenderer === child) ownedRenderer = null
    publishSession(null)
    return true
  }
  return false
}

async function superviseRenderer() {
  let unavailableProbes = 0
  while (!stopping) {
    await delay(250)
    if (stopRequested()) {
      stopping = true
      break
    }
    const state = await probeRenderer()
    if (state === 'ready' || state === 'starting') {
      unavailableProbes = 0
      continue
    }
    if (state === 'occupied') {
      console.error(`Error: Port ${port} was taken over by a server that is not this RMS renderer.`)
      process.exitCode = 1
      break
    }

    unavailableProbes += 1
    if (unavailableProbes < 8) continue
    unavailableProbes = 0

    if (!await stopManagedRenderer()) {
      console.error(`Error: RMS renderer process could not be stopped at ${url}.`)
      process.exitCode = 1
      break
    }

    console.log(`RMS_RENDERER_RECOVERING ${url}`)
    if (!await startRenderer()) {
      console.error(`Error: RMS renderer could not be recovered at ${url}.`)
      process.exitCode = 1
      break
    }
    console.log(`RMS_RENDERER_READY ${url} (recovered)`)
  }

  const rendererStopped = await stopManagedRenderer()
  if (!rendererStopped) {
    console.error(`Error: RMS renderer process could not be stopped at ${url}.`)
    process.exitCode = 1
    return
  }
  const current = readJson(sessionPath)
  if (current?.token === token) removeFile(sessionPath)
  if (readJson(stopPath)?.token === token) removeFile(stopPath)
}

console.log(`RMS_RENDERER_STARTING ${url}`)
const previousSession = readJson(sessionPath)
const previousSupervisorWasRunning = !checkOnly
  && matchingSession(previousSession)
  && isRunning(previousSession.supervisorPid)
if (previousSupervisorWasRunning && !await stopPreviousSupervisor(previousSession)) {
  console.error(`Error: Previous RMS renderer supervisor did not stop at ${url}.`)
  process.exit(1)
}
if (previousSupervisorWasRunning) {
  await waitUntil(async () => await probeRenderer() === 'available', 5_000)
}

const initialState = await probeRenderer()
if (initialState === 'occupied') {
  console.error(`Error: Port ${port} is used by a server that is not this RMS renderer.`)
  process.exit(1)
}
if (initialState === 'ready') {
  console.log(`RMS_RENDERER_READY ${url} (reused)`)
  if (!checkOnly) {
    const adoptPid = matchingSession(previousSession) && isRunning(previousSession.rendererPid)
      ? previousSession.rendererPid
      : null
    publishSession(adoptPid)
    await superviseRenderer()
  }
  process.exit(process.exitCode || 0)
}
if (checkOnly) {
  console.error(`Error: RMS renderer is not available at ${url}.`)
  process.exit(1)
}

if (!await startRenderer()) {
  requestLocalStop()
  await superviseRenderer()
  console.error(`Error: RMS renderer did not become ready at ${url}.`)
  process.exit(1)
}
console.log(`RMS_RENDERER_READY ${url} (started)`)
await superviseRenderer()
