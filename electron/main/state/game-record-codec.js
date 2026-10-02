const zlib = require('node:zlib')
const { expandAnalysisCaches } = require('./analysis-cache-storage')

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
