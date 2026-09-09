import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const localPython = process.platform === 'win32'
  ? path.join(root, '.conda-backend', 'python.exe')
  : path.join(root, '.conda-backend', 'bin', 'python')
const python = String(process.env.MJAI_BACKEND_PYTHON || '').trim()
  || (existsSync(localPython) ? localPython : 'python')

const result = spawnSync(python, [
  '-m', 'unittest', 'discover',
  '-s', 'python/tests',
  '-t', 'python',
  '-p', 'test_*.py',
], {
  cwd: root,
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
