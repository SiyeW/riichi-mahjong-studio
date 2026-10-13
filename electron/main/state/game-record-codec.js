const zlib = require('node:zlib')
const { createHash } = require('node:crypto')
const { expandAnalysisCaches, unpackJson } = require('./analysis-cache-storage')

const BLOCK_MAGIC = Buffer.from('MJSTBLK1')

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
