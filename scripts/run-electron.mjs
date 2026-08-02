import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')

const { ELECTRON_RUN_AS_NODE: _, ...cleanEnv } = process.env

const isWindows = process.platform === 'win32'
const electronBinary = isWindows
  ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(root, 'node_modules', 'electron', 'dist', 'electron')

const child = spawn(electronBinary, process.argv.slice(2), {
  cwd: root,
  stdio: 'inherit',
  env: cleanEnv,
})

child.on('exit', (code) => {
  process.exit(code ?? 0)
})
