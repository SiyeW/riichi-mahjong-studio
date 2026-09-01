import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

const host = '127.0.0.1'
const port = Number(process.env.RMS_RENDERER_PORT || 5173)
const url = `http://${host}:${port}`
const root = path.resolve(import.meta.dirname, '..')
const viteEntry = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const checkOnly = process.argv.includes('--check')

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

async function waitForRenderer(child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await probeRenderer()
    if (state === 'ready') return true
    if (state === 'occupied' || child.exitCode !== null) return false
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return false
}

function startRenderer() {
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
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  return child
}

let ownedRenderer = null
let stopping = false

function stop() {
  stopping = true
  if (ownedRenderer?.exitCode === null) ownedRenderer.kill('SIGTERM')
}

process.once('SIGINT', stop)
process.once('SIGTERM', stop)
process.once('exit', () => {
  if (ownedRenderer?.exitCode === null) ownedRenderer.kill('SIGTERM')
})

async function ensureRenderer() {
  ownedRenderer = startRenderer()
  if (await waitForRenderer(ownedRenderer)) return true

  // Another task may have won the strict-port race while this child started.
  if (await probeRenderer() === 'ready') {
    ownedRenderer = null
    return true
  }
  return false
}

async function superviseRenderer() {
  while (!stopping) {
    await new Promise(resolve => setTimeout(resolve, 500))
    if (stopping) break
    const state = await probeRenderer()
    if (state === 'ready' || state === 'starting') continue
    if (state === 'occupied') {
      console.error(`Error: Port ${port} was taken over by a server that is not this RMS renderer.`)
      process.exitCode = 1
      break
    }

    console.log(`RMS_RENDERER_RECOVERING ${url}`)
    if (!await ensureRenderer()) {
      console.error(`Error: RMS renderer could not be recovered at ${url}.`)
      process.exitCode = 1
      break
    }
    console.log(`RMS_RENDERER_READY ${url} (recovered)`)
  }
  stop()
}

console.log(`RMS_RENDERER_STARTING ${url}`)
const initialState = await probeRenderer()
if (initialState === 'occupied') {
  console.error(`Error: Port ${port} is used by a server that is not this RMS renderer.`)
  process.exit(1)
}
if (initialState === 'ready') {
  console.log(`RMS_RENDERER_READY ${url} (reused)`)
  if (!checkOnly) await superviseRenderer()
  process.exit(0)
}
if (checkOnly) {
  console.error(`Error: RMS renderer is not available at ${url}.`)
  process.exit(1)
}

if (!await ensureRenderer()) {
  stop()
  console.error(`Error: RMS renderer did not become ready at ${url}.`)
  process.exit(1)
}
console.log(`RMS_RENDERER_READY ${url} (started)`)
await superviseRenderer()
