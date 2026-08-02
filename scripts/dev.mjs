import { execSync, spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const port = 5173
const serverUrl = `http://127.0.0.1:${port}`

// Kill any process already holding the port
if (process.platform === 'win32') {
  try {
    const out = execSync(`netstat -ano | findstr ":${port} "`, { encoding: 'utf8' })
    const pid = out.split(/\r?\n/).find(l => l.includes('LISTENING') && l.includes(`:${port}`))?.match(/LISTENING\s+(\d+)/)?.[1]
    if (pid) {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' })
      console.log(`Killed previous process (PID ${pid}) on port ${port}`)
    }
  } catch { /* nothing to kill */ }
}

const vite = spawn('npm', ['run', 'dev:renderer', '--', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: root,
  shell: true,
  stdio: 'inherit',
})

const shutdown = () => {
  vite.kill()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const isReady = await new Promise((resolve) => {
      const request = http.get(url, (response) => {
        response.resume()
        resolve(response.statusCode === 200)
      })

      request.on('error', () => resolve(false))
      request.setTimeout(1000, () => {
        request.destroy()
        resolve(false)
      })
    })

    if (isReady) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`Timed out waiting for ${url}`)
}

try {
  await waitForServer(serverUrl, 30_000)

  const electronBinary = process.platform === 'win32'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(root, 'node_modules', 'electron', 'dist', 'electron')

  const { ELECTRON_RUN_AS_NODE: _, ...cleanEnv } = process.env

  const electron = spawn(electronBinary, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...cleanEnv,
      VITE_DEV_SERVER_URL: serverUrl,
    },
  })

  electron.on('exit', (code) => {
    vite.kill()
    process.exit(code ?? 0)
  })
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  vite.kill()
  process.exit(1)
}
