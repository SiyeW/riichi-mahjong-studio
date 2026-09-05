const test = require('node:test')
const assert = require('node:assert/strict')
const { createGameFileStore } = require('./game-file-store')
const { withCurrentRecord } = require('./record-operation')

test('replacing or closing a record invalidates a pending file operation', async () => {
  for (const change of [store => store.beginRecord({ dirty: true }), store => store.closeRecord()]) {
    const store = createGameFileStore(process.cwd())
    store.beginRecord({ dirty: true })
    let finish
    const operation = withCurrentRecord(store, () => new Promise(resolve => { finish = resolve }))
    change(store)
    finish({ record: 'old' })
    await assert.rejects(operation, /current record changed/)
  }
})

test('editing and browsing keep a pending save valid without marking new changes saved', async () => {
  const store = createGameFileStore(process.cwd())
  store.beginRecord({ dirty: true, nodeId: 'A' })
  const revision = store.getRevision()
  const result = await withCurrentRecord(store, async () => {
    store.markCurrentNode('B')
    store.markDirty()
    return 'saved snapshot'
  })
  assert.equal(result, 'saved snapshot')
  store.markSaved(revision)
  assert.equal(store.isDirty(), true)
})
