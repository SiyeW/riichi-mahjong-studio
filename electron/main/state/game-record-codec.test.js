const assert = require('node:assert/strict')
const { test } = require('node:test')
const zlib = require('node:zlib')

const {
  decodeGameRecord,
  encodeGameRecord,
  getRecoverySourcePath,
  isRecoveryGameRecord,
  prepareGameRecordForWrite,
} = require('./game-record-codec')

function testWriteMetadataIsPortable() {
  const source = {
    formatVersion: 2,
    metadata: {
      app: 'riichi-mahjong-studio',
      models: {
        teachingModel: { modelPath: 'D:\\models\\example.pth' },
      },
      recovery: { kind: 'stale-marker' },
    },
    state: {},
    game: {},
  }

  const formal = prepareGameRecordForWrite(source, { appVersion: '0.4.0-alpha.1' })
  assert.equal(formal.metadata.appVersion, '0.4.0-alpha.1')
  assert.equal(formal.metadata.app, undefined)
  assert.equal(formal.metadata.recordType, undefined)
  assert.equal(formal.metadata.models, undefined)
  assert.equal(formal.metadata.recovery, undefined)
  assert.equal(isRecoveryGameRecord(formal), false)
  assert.equal(getRecoverySourcePath(formal), '')
  assert.ok(source.metadata.models)

  const recovery = prepareGameRecordForWrite(source, {
    appVersion: '0.4.0-alpha.1',
    recovery: true,
  })
  assert.equal(isRecoveryGameRecord(recovery), true)
  assert.equal(recovery.metadata.recovery.schemaVersion, 3)
  assert.equal(recovery.metadata.recovery.sourcePath, undefined)
  assert.equal(getRecoverySourcePath(recovery), '')

  const legacyRecovery = {
    metadata: {
      recovery: {
        kind: 'unsaved-exit',
        schemaVersion: 2,
        sourcePath: 'D:\\records\\legacy.mjtrain',
      },
    },
  }
  assert.equal(getRecoverySourcePath(legacyRecovery), 'D:\\records\\legacy.mjtrain')

  const decoded = decodeGameRecord(encodeGameRecord(recovery))
  assert.deepEqual(decoded, recovery)
}

testWriteMetadataIsPortable()

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
