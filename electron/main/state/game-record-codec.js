const zlib = require('node:zlib')
const { createHash } = require('node:crypto')
const { expandAnalysisCaches, unpackJson } = require('./analysis-cache-storage')
const { decodeAnalysisBody, validateAnalysisSchema } = require('./analysis-body-codec')

const BLOCK_MAGIC = Buffer.from('MJSTBLK1')
const BLOCK_V2_MAGIC = Buffer.from('MJSTBLK2')
const DIRECTORY_LIMIT = 64 * 1024 * 1024

function decodeV2Record(buffer) {
  if (buffer.length < 16) throw new Error('Incomplete native record header.')
  const size = Number(buffer.readBigUInt64LE(8))
  if (!Number.isSafeInteger(size) || size > DIRECTORY_LIMIT + 65536 || size > buffer.length - 16) throw new Error('Invalid native directory length.')
  const directory = zlib.gunzipSync(buffer.subarray(16, 16 + size), { maxOutputLength: DIRECTORY_LIMIT })
  if (directory.length < 8) throw new Error('Incomplete native record directory.')
  const length = Number(directory.readBigUInt64LE())
  if (!Number.isSafeInteger(length) || length > directory.length - 8) throw new Error('Invalid native manifest length.')
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(directory.subarray(8, 8 + length)))
  if (manifest.version !== 2 || manifest.policy !== 'sparse-p20-ticks-v1'
      || !Number.isSafeInteger(manifest.blockCount) || manifest.blockCount < 0
      || directory.length !== 8 + length + manifest.blockCount * 48
      || !Array.isArray(manifest.schemas) || !Array.isArray(manifest.entries)
      || !manifest.record?.game?.nodes || 'analysisCacheStorage' in manifest.record) throw new Error('Invalid native record directory.')
  manifest.schemas.forEach(validateAnalysisSchema)
  const bodies = [], referenced = new Set(), seen = new Set()
  let offset = 0
  for (let index = 0; index < manifest.blockCount; index += 1) {
    const start = 8 + length + index * 48
    const position = Number(directory.readBigUInt64LE(start)), bodyLength = Number(directory.readBigUInt64LE(start + 8))
    if (position !== offset || !Number.isSafeInteger(bodyLength) || bodyLength <= 0 || offset + bodyLength > buffer.length - 16 - size) throw new Error('Invalid native body bounds.')
    const data = buffer.subarray(16 + size + offset, 16 + size + offset + bodyLength)
    if (!createHash('sha256').update(data).digest().equals(directory.subarray(start + 16, start + 48))) throw new Error('Damaged analysis result block.')
    bodies.push(decodeAnalysisBody(zlib.gunzipSync(data, { maxOutputLength: 32 * 1024 * 1024 }), manifest.schemas))
    offset += bodyLength
  }
  if (16 + size + offset !== buffer.length) throw new Error('Native record has trailing data.')
  const nodes = manifest.record.game.nodes
  for (const node of Object.values(nodes)) {
    if (!node || typeof node !== 'object' || ['analysisCache', 'opponentAnalysisCache'].some(field => field in node)) throw new Error('Invalid native record tree.')
  }
  for (const entry of manifest.entries) {
    const node = Object.hasOwn(nodes, entry.node) ? nodes[entry.node] : null
    const identity = JSON.stringify([entry.node, entry.field, entry.key])
    if (!node || !['analysisCache', 'opponentAnalysisCache'].includes(entry.field) || typeof entry.key !== 'string'
        || seen.has(identity) || !Number.isInteger(entry.body) || entry.body < 0 || entry.body >= bodies.length) throw new Error('Invalid native analysis entry.')
    if (!entry.fields || typeof entry.fields !== 'object' || Array.isArray(entry.fields)
        || JSON.stringify(Object.keys(entry.fields).sort()) !== JSON.stringify(Object.keys(bodies[entry.body]).sort())
        || Object.entries(entry.fields).some(([key, metadata]) => (
          !Array.isArray(metadata) || metadata.length !== 2 || typeof metadata[0] !== 'boolean'
          || metadata[0] && (metadata[1] !== null && typeof metadata[1] === 'object' || bodies[entry.body][key] !== metadata[1])
          || !metadata[0] && metadata[1] !== null
        ))) throw new Error('Analysis summary does not match its block.')
    seen.add(identity); referenced.add(entry.body)
    node[entry.field] ??= {}
    Object.defineProperty(node[entry.field], entry.key, { value: bodies[entry.body], enumerable: true, configurable: true, writable: true })
  }
  if (referenced.size !== bodies.length) throw new Error('Unreferenced native analysis body.')
  return manifest.record
}

// Explicit eager reader for diagnostics/tests. Interactive file I/O belongs to
// Python and reads the directory and requested blocks only.
function decodeBlockRecord(buffer) {
  if (buffer.length < 16) throw new Error('Incomplete indexed record header.')
  const size = Number(buffer.readBigUInt64LE(8))
  if (!Number.isSafeInteger(size) || size > buffer.length - 16) throw new Error('Invalid indexed record directory.')
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(zlib.gunzipSync(buffer.subarray(16, 16 + size))))
  if (manifest.version !== 1 || !Array.isArray(manifest.entries) || !manifest.record?.game?.nodes) {
    throw new Error('Unsupported indexed record directory.')
  }
  const record = manifest.record
  const seen = new Set()
  let offset = 0
  for (const entry of manifest.entries) {
    const node = Object.hasOwn(record.game.nodes, entry.node) ? record.game.nodes[entry.node] : null
    const identity = JSON.stringify([entry.node, entry.field, entry.key])
    if (!node || typeof node !== 'object' || Array.isArray(node)
        || !['analysisCache', 'opponentAnalysisCache'].includes(entry.field) || typeof entry.key !== 'string'
        || seen.has(identity) || entry.offset !== offset || !Number.isSafeInteger(entry.length) || entry.length <= 0
        || offset + entry.length > buffer.length - 16 - size) throw new Error('Invalid analysis directory entry.')
    seen.add(identity)
    const data = buffer.subarray(16 + size + offset, 16 + size + offset + entry.length)
    if (createHash('sha256').update(data).digest('hex') !== entry.sha256) throw new Error('Damaged analysis result block.')
    const values = unpackJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(zlib.gunzipSync(data))))
    if (!Array.isArray(values) || values.length !== 1 || !values[0] || typeof values[0] !== 'object') {
      throw new Error('Invalid analysis result block.')
    }
    node[entry.field] ??= {}
    Object.defineProperty(node[entry.field], entry.key, { value: values[0], enumerable: true, configurable: true, writable: true })
    offset += entry.length
  }
  if (16 + size + offset !== buffer.length) throw new Error('Indexed record has trailing data.')
  return record
}

const RECOVERY_RECORD_KIND = 'unsaved-exit'

function isGzipBuffer(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
}

function encodeGameRecord(record, compressed = true) {
  const json = Buffer.from(JSON.stringify(record), 'utf8')
  return compressed ? zlib.gzipSync(json, { level: 6 }) : json
}

function decodeGameRecord(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buffer.subarray(0, 8).equals(BLOCK_V2_MAGIC)) return decodeV2Record(buffer)
  if (buffer.subarray(0, 8).equals(BLOCK_MAGIC)) return decodeBlockRecord(buffer)
  const json = isGzipBuffer(buffer) ? zlib.gunzipSync(buffer) : buffer
  return expandAnalysisCaches(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)))
}

function isRecoveryGameRecord(record) {
  return record?.metadata?.recovery?.kind === RECOVERY_RECORD_KIND
}

function getRecoverySourcePath(record) {
  if (!isRecoveryGameRecord(record)) return ''
  const sourcePath = record?.metadata?.recovery?.sourcePath
  return typeof sourcePath === 'string' ? sourcePath.trim() : ''
}

module.exports = {
  RECOVERY_RECORD_KIND,
  decodeGameRecord,
  encodeGameRecord,
  getRecoverySourcePath,
  isGzipBuffer,
  isRecoveryGameRecord,
}
