import assert from 'node:assert/strict'
import test from 'node:test'
import { createRevisionSaveQueue } from './revisionSaveQueue.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('unchanged drafts need no save and multiple edits use the latest snapshot', async () => {
  let value = 'initial'
  const sent: string[] = []
  const queue = createRevisionSaveQueue(() => value, async snapshot => { sent.push(snapshot); return true })
  assert.equal(await queue.flush(), true)
  assert.deepEqual(sent, [])
  queue.changed()
  value = 'latest'
  queue.changed()
  assert.equal(await queue.flush(), true)
  assert.deepEqual(sent, ['latest'])
  assert.equal(queue.pending, false)
  assert.equal(queue.saving, false)
})

test('concurrent flushes share a request and then save edits made in flight', async () => {
  let value = 'first'
  const first = deferred<boolean>()
  const started = deferred<void>()
  const sent: Array<[string, number]> = []
  const queue = createRevisionSaveQueue(() => value, async (snapshot, revision) => {
    sent.push([snapshot, revision])
    if (sent.length === 1) { started.resolve(); return first.promise }
    return true
  })
  queue.changed()
  const a = queue.flush()
  const b = queue.flush()
  await started.promise
  assert.equal(queue.saving, true)
  value = 'second'
  queue.changed()
  const c = queue.flush()
  assert.deepEqual(sent, [['first', 1]])
  first.resolve(true)
  assert.deepEqual(await Promise.all([a, b, c]), [true, true, true])
  assert.deepEqual(sent, [['first', 1], ['second', 2]])
  assert.equal(queue.pending, false)
})

test('a failed save leaves changes pending and allows explicit retry', async () => {
  let succeeds = false
  const queue = createRevisionSaveQueue(() => 'draft', async () => succeeds)
  queue.changed()
  assert.equal(await queue.flush(), false)
  assert.equal(queue.pending, true)
  assert.equal(queue.saving, false)
  succeeds = true
  assert.equal(await queue.flush(), true)
  assert.equal(queue.pending, false)
})

test('rejected requests release the shared request and can be retried', async () => {
  let fails = true
  const queue = createRevisionSaveQueue(() => 'draft', async () => {
    if (fails) throw new Error('unavailable')
    return true
  })
  queue.changed()
  const results = await Promise.allSettled([queue.flush(), queue.flush()])
  assert.ok(results.every(result => result.status === 'rejected'))
  assert.equal(queue.saving, false)
  assert.equal(queue.pending, true)
  fails = false
  assert.equal(await queue.flush(), true)
})

test('an external acknowledgement cannot mark later edits as saved', async () => {
  let calls = 0
  const queue = createRevisionSaveQueue(() => 'draft', async () => { calls++; return true })
  queue.changed()
  const operationRevision = queue.revision
  queue.changed()
  queue.acknowledge(operationRevision)
  assert.equal(queue.pending, true)
  await queue.flush()
  assert.equal(calls, 1)
  queue.acknowledge(operationRevision)
  assert.equal(queue.pending, false)
  queue.changed()
  assert.equal(queue.pending, true)
})

test('snapshot failures leave a retryable draft without a stuck request', async () => {
  let fails = true
  const queue = createRevisionSaveQueue(() => {
    if (fails) throw new Error('snapshot failed')
    return 'draft'
  }, async () => true)
  queue.changed()
  await assert.rejects(queue.flush(), /snapshot failed/)
  assert.equal(queue.saving, false)
  assert.equal(queue.pending, true)
  fails = false
  assert.equal(await queue.flush(), true)
})
