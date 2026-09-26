const { parentPort, workerData } = require('node:worker_threads')
const { encodeGameRecord } = require('./game-record-codec')

const encoded = encodeGameRecord(workerData.record, workerData.compressed)
const bytes = new Uint8Array(encoded.length)
bytes.set(encoded)
parentPort.postMessage(bytes, [bytes.buffer])
