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

test('a late download or file selection cannot reach the import step after switching records', async () => {
  for (const prepared of [{ report: {} }, { filePaths: ['example.mjstudio'] }]) {
    for (const change of [store => store.beginRecord({ dirty: true }), store => store.closeRecord()]) {
      const store = createGameFileStore(process.cwd())
      store.beginRecord({ dirty: false })
      let finish
      let imports = 0
      const operation = (async () => {
        const result = await withCurrentRecord(store, () => new Promise(resolve => { finish = resolve }))
        imports += 1
        return result
      })()
      change(store)
      finish(prepared)
      await assert.rejects(operation, /current record changed/)
      assert.equal(imports, 0)
    }
  }
})

test('a prepared import still proceeds when its original record remains current', async () => {
  const store = createGameFileStore(process.cwd())
  store.beginRecord({ dirty: false })
  const prepared = { report: { mjai_log: [{}] } }
  const result = await withCurrentRecord(store, async () => prepared)
  assert.equal(result, prepared)
})
