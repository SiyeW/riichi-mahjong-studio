const assert = require('node:assert/strict')

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
console.log('game record codec tests passed')
