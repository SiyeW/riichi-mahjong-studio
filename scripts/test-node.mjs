import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const testRoots = ['electron', 'locales', 'src']

function collectTests(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name)
      return entry.isDirectory() ? collectTests(entryPath) : [entryPath]
    })
    .filter((file) => /\.test\.(?:js|ts)$/.test(file))
}

const tests = testRoots
  .flatMap((directory) => collectTests(path.join(root, directory)))
  .sort((left, right) => left.localeCompare(right, 'en'))

if (tests.length === 0) {
  console.error('No Node.js tests were found.')
  process.exit(1)
}

const result = spawnSync(process.execPath, ['--test', ...tests], {
  cwd: root,
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
