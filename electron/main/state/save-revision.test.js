const test = require('node:test')
const assert = require('node:assert/strict')
const { createGameFileStore } = require('./game-file-store')

test('saving an earlier revision does not clear edits or navigation made during export', () => {
  for (const change of [store => store.markDirty(), store => store.markCurrentNode('B')]) {
    const store = createGameFileStore(process.cwd())
    store.beginRecord({ dirty: true, nodeId: 'A' })
    const exportedRevision = store.getRevision()
    change(store)
    store.markSaved(exportedRevision)
    assert.equal(store.isDirty(), true)
    store.markSaved(store.getRevision())
    assert.equal(store.isDirty(), false)
  }
})
