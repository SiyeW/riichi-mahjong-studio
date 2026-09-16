import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import zlib from 'node:zlib'

const [, , sourceArgument = 'records/示例牌谱.mjstudio', destinationArgument = 'examples/example-record.mjstudio'] = process.argv
const projectRoot = path.resolve(import.meta.dirname, '..')
const sourcePath = path.resolve(projectRoot, sourceArgument)
const destinationPath = path.resolve(projectRoot, destinationArgument)

function decodeRecord(filePath) {
  const input = fs.readFileSync(filePath)
  const json = input[0] === 0x1f && input[1] === 0x8b ? zlib.gunzipSync(input) : input
  return JSON.parse(json.toString('utf8'))
}

function renameCacheKeys(cache, sourceIds) {
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) return cache
  return Object.fromEntries(Object.entries(cache).map(([cacheKey, value]) => {
    const parts = cacheKey.split('::')
    if (parts.length === 4 && sourceIds.has(parts[3])) parts[3] = sourceIds.get(parts[3])
    return [parts.join('::'), sanitizeCachedValue(value)]
  }))
}

function sanitizeCachedValue(value, key = '') {
  if (Array.isArray(value)) return value.map((entry) => sanitizeCachedValue(entry))
  if (!value || typeof value !== 'object') {
    if (key === 'model') return 'example-analysis'
    if (typeof value !== 'string') return value
    return value
      .replaceAll("Mortal's raw value for the action.", 'Raw value reported for the action.')
      .replaceAll("A display-oriented probability derived from Mortal's Q values.", 'A display-oriented probability derived from the action values.')
  }
  return Object.fromEntries(Object.entries(value).flatMap(([entryKey, entryValue]) => {
    if (entryKey === 'engineFingerprint') return []
    return [[entryKey, sanitizeCachedValue(entryValue, entryKey)]]
  }))
}

function publicAnalysisSources(game) {
  const sources = game.analysisSources && typeof game.analysisSources === 'object'
    ? game.analysisSources
    : {}
  const sourceIds = new Map()
  const counts = { decision: 0, opponent: 0 }
  const preparedSources = []
  for (const [sourceId, source] of Object.entries(sources)) {
    if (!source || typeof source !== 'object') continue
    const kind = source.kind === 'decision' ? 'decision' : 'opponent'
    const ordinal = ++counts[kind]
    const prefix = kind === 'decision' ? 'm' : 'o'
    const publicId = `${prefix}-public-example-${ordinal}`
    sourceIds.set(sourceId, publicId)
    preparedSources.push([publicId, {
      schemaVersion: 2,
      kind,
      engineIdentity: `public-example-${kind}-${ordinal}`,
      outputContract: String(source.outputContract || ''),
      ...(source.hostPostprocessorVersion
        ? { hostPostprocessorVersion: String(source.hostPostprocessorVersion) }
        : {}),
      id: publicId,
      cacheFingerprint: `public-example-${kind}-${ordinal}`,
      displayName: `${kind === 'decision' ? 'Example decision analysis' : 'Example opponent analysis'} ${ordinal}`,
    }])
  }
  return { sourceIds, sources: Object.fromEntries(preparedSources) }
}

const record = decodeRecord(sourcePath)
if (!record?.game?.nodes || typeof record.game.nodes !== 'object') {
  throw new Error(`Not a supported Studio record: ${sourcePath}`)
}

const { sourceIds, sources } = publicAnalysisSources(record.game)
for (const node of Object.values(record.game.nodes)) {
  if (!node || typeof node !== 'object') continue
  node.analysisCache = renameCacheKeys(node.analysisCache, sourceIds)
  if (node.opponentAnalysisCache) {
    node.opponentAnalysisCache = renameCacheKeys(node.opponentAnalysisCache, sourceIds)
  }
}

record.game.analysisSources = sources
record.game.metadata = {
  ...(record.game.metadata && typeof record.game.metadata === 'object' ? record.game.metadata : {}),
  label: 'Example Record',
  source: 'example-record',
}
record.metadata = {
  ...(record.metadata && typeof record.metadata === 'object' ? record.metadata : {}),
  appVersion: JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version,
}

const encoded = zlib.gzipSync(Buffer.from(JSON.stringify(record), 'utf8'), { level: 9 })
fs.mkdirSync(path.dirname(destinationPath), { recursive: true })
fs.writeFileSync(destinationPath, encoded)
console.log(`Prepared public example: ${destinationPath}`)
