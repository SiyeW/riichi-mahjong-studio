const test = require('node:test')
const assert = require('node:assert/strict')
const { createRecord } = require('./create-record')

test('failed creation leaves file tracking untouched', async () => {
  const calls = []
  await assert.rejects(createRecord(async () => { throw new Error('engine unavailable') },
    { prepareUnsavedRecord: () => calls.push('path') }, () => calls.push('dirty')), /engine unavailable/)
  assert.deepEqual(calls, [])
})

test('file tracking changes only after creation succeeds', async () => {
  const calls = []
  const response = { gameLoaded: true }
  const result = await createRecord(async () => { calls.push('created'); return response },
    { prepareUnsavedRecord: () => calls.push('path') }, options => calls.push(options))
  assert.equal(result, response)
  assert.deepEqual(calls, ['created', 'path', { dirty: true }])
})
