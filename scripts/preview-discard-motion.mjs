import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'

const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-motion-preview-'))
let server
let closing = false
async function close() {
  if (closing) return
  closing = true
  try { await server?.close() }
  finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
}
process.on('SIGINT', () => { void close() })
process.on('SIGTERM', () => { void close() })
try {
  server = await createServer({ root, mode: 'ui-test', cacheDir: path.join(temporary, 'vite-cache'),
    server: { host: '127.0.0.1', port: 5178, strictPort: false } })
  await server.listen()
  console.log(`${server.resolvedUrls.local[0]}scripts/visual-tests/discard-motion/index.html`)
} catch (error) { await close(); throw error }
