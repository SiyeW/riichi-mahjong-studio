const zlib = require('node:zlib')

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
  return JSON.parse(json.toString('utf8').replace(/^\uFEFF/, ''))
}

function prepareGameRecordForWrite(record, options = {}) {
  const sourceMetadata = record?.metadata
  const metadata = {
    ...(sourceMetadata && typeof sourceMetadata === 'object' ? sourceMetadata : {}),
  }
  delete metadata.models
  delete metadata.recovery
  delete metadata.app
  delete metadata.recordType
  if (options.appVersion) {
    metadata.appVersion = String(options.appVersion)
  }
  if (options.recovery) {
    metadata.recovery = {
      kind: RECOVERY_RECORD_KIND,
      schemaVersion: 3,
    }
  }
  return {
    ...record,
    metadata,
  }
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
  prepareGameRecordForWrite,
}
