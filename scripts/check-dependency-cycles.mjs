import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')

function walk(directory, extensions) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return walk(entryPath, extensions)
    return extensions.has(path.extname(entry.name)) && !/\.test\.[^.]+$/.test(entry.name)
      ? [path.normalize(entryPath)]
      : []
  })
}

function resolveModule(sourceFile, specifier, extensions) {
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(sourceFile), specifier)
  const candidates = [
    base,
    ...extensions.map((extension) => `${base}${extension}`),
    ...extensions.map((extension) => path.join(base, `index${extension}`)),
  ]
  return candidates.find((candidate) => existsSync(candidate)) || null
}

function javascriptGraph() {
  const extensions = ['.js', '.mjs', '.ts', '.vue']
  const files = [
    ...walk(path.join(root, 'src'), new Set(extensions)),
    ...walk(path.join(root, 'electron', 'main'), new Set(extensions)),
  ]
  const fileSet = new Set(files)
  const graph = new Map(files.map((file) => [file, new Set()]))
  const patterns = [
    /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const dependency = resolveModule(file, match[1], extensions)
        if (dependency && fileSet.has(path.normalize(dependency))) {
          graph.get(file).add(path.normalize(dependency))
        }
      }
    }
  }
  return graph
}

function pythonGraph() {
  const packageRoot = path.join(root, 'python', 'rms_backend')
  const files = walk(packageRoot, new Set(['.py']))
  const fileSet = new Set(files)
  const graph = new Map(files.map((file) => [file, new Set()]))
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/^from\s+(\.+)([\w.]*)\s+import\s+([^#\r\n]+)/gm)) {
      const levels = match[1].length
      let base = path.dirname(file)
      for (let index = 1; index < levels; index += 1) base = path.dirname(base)
      if (match[2]) {
        const dependency = path.join(base, ...match[2].split('.')) + '.py'
        if (fileSet.has(dependency)) graph.get(file).add(dependency)
        continue
      }
      for (const imported of match[3].split(',').map((part) => part.trim().split(/\s+as\s+/)[0])) {
        if (!/^\w+$/.test(imported)) continue
        const dependency = path.join(base, `${imported}.py`)
        if (fileSet.has(dependency)) graph.get(file).add(dependency)
      }
    }
  }
  return graph
}

function findCycles(graph) {
  const complete = new Set()
  const active = new Map()
  const stack = []
  const cycles = []

  function visit(node) {
    if (complete.has(node)) return
    const activeIndex = active.get(node)
    if (activeIndex !== undefined) {
      cycles.push([...stack.slice(activeIndex), node])
      return
    }
    active.set(node, stack.length)
    stack.push(node)
    for (const dependency of graph.get(node) || []) visit(dependency)
    stack.pop()
    active.delete(node)
    complete.add(node)
  }

  for (const node of graph.keys()) visit(node)
  return cycles
}

const cycles = [javascriptGraph(), pythonGraph()].flatMap(findCycles)
if (cycles.length) {
  console.error('Dependency cycles detected:')
  for (const cycle of cycles) {
    console.error(cycle.map((file) => path.relative(root, file)).join(' -> '))
  }
  process.exit(1)
}

console.log('Frontend, Electron, and Python production dependency graphs are acyclic.')
