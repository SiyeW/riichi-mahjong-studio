const zlib = require('node:zlib')
const path = require('node:path')
const { Worker } = require('node:worker_threads')
const { compactAnalysisCaches, expandAnalysisCaches } = require('./analysis-cache-storage')

const RECOVERY_RECORD_KIND = 'unsaved-exit'

function isGzipBuffer(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
}

function encodeGameRecord(record, compressed = true) {
  const json = Buffer.from(JSON.stringify(record), 'utf8')
  return compressed ? zlib.gzipSync(json, { level: 6 }) : json
}

async function encodeGameRecordAsync(record, compressed = true) {
  // JSON encoding is CPU work too; async gzip alone still freezes the main
  // process before compression starts. Each save owns its worker until exit.
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'game-record-encoder.js'), {
      workerData: { record, compressed },
    })
    let encoded
    worker.once('message', bytes => { encoded = Buffer.from(bytes) })
    worker.once('error', reject)
    worker.once('exit', code => {
      if (code === 0 && encoded) resolve(encoded)
      else reject(new Error(`Record encoder exited without a result (code ${code}).`))
    })
  })
}

function decodeGameRecord(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const json = isGzipBuffer(buffer) ? zlib.gunzipSync(buffer) : buffer
  return expandAnalysisCaches(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json)))
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
  return compactAnalysisCaches({
    ...record,
    metadata,
  })
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
  encodeGameRecordAsync,
  getRecoverySourcePath,
  isGzipBuffer,
  isRecoveryGameRecord,
  prepareGameRecordForWrite,
}
