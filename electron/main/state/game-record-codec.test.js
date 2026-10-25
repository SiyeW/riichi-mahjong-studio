const assert = require('node:assert/strict')
const { test } = require('node:test')
const zlib = require('node:zlib')

const {
  decodeGameRecord,
  encodeGameRecord,
  getRecoverySourcePath,
  isRecoveryGameRecord,
} = require('./game-record-codec')

test('legacy inline analysis caches remain readable without migration metadata', () => {
  const legacy = {
    formatVersion: 2,
    game: {
      nodes: {
        n1: {
          analysisCache: { model: { entries: [{ action: 'dahai', probability: 0.75 }] } },
          opponentAnalysisCache: { model: { outputs: { probability: 0.125 } } },
        },
      },
    },
  }
  const decoded = decodeGameRecord(zlib.gzipSync(Buffer.from(JSON.stringify(legacy))))
  assert.deepEqual(decoded, legacy)
  assert.equal(decoded.analysisCacheStorage, undefined)
})

test('recovery metadata recognizes the legacy source path', () => {
  const record = { metadata: { recovery: {
    kind: 'unsaved-exit', schemaVersion: 2, sourcePath: ' D:/records/legacy.mjtrain ',
  } } }
  assert.equal(isRecoveryGameRecord(record), true)
  assert.equal(getRecoverySourcePath(record), 'D:/records/legacy.mjtrain')
  assert.equal(getRecoverySourcePath({ metadata: { recovery: { kind: 'other' } } }), '')
})

test('record decoding preserves Unicode and accepts a UTF-8 BOM with or without compression', () => {
  const record = { comment: '评论・牌譜🀄・literal replacement character �' }
  for (const bom of ['', '\uFEFF']) {
    const json = Buffer.from(bom + JSON.stringify(record), 'utf8')
    for (const data of [json, zlib.gzipSync(json)]) {
      assert.deepEqual(decodeGameRecord(data), record)
    }
  }
})

test('record decoding rejects damaged UTF-8 rather than silently changing comments', () => {
  for (const invalid of [[0xff], [0xc3, 0x28], [0xed, 0xa0, 0x80], [0xf0, 0x9f]]) {
    const json = Buffer.concat([
      Buffer.from('{"comment":"'), Buffer.from(invalid), Buffer.from('"}'),
    ])
    for (const data of [json, zlib.gzipSync(json)]) {
      assert.throws(() => decodeGameRecord(data), { code: 'ERR_ENCODING_INVALID_ENCODED_DATA' })
    }
  }
})

test('record decoding rejects truncated compressed input and invalid JSON', () => {
  const data = encodeGameRecord({ comment: 'record' })
  assert.throws(() => decodeGameRecord(data.subarray(0, data.length - 4)))
  assert.throws(() => decodeGameRecord(Buffer.from('{"comment":')))
})
console.log('game record codec tests passed')
