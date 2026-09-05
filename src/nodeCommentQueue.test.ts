import assert from 'node:assert/strict'
import test from 'node:test'
import { createNodeCommentQueue, nodeCommentKey } from './nodeCommentQueue.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('comment keys isolate identical node ids in different games', () => {
  assert.notEqual(nodeCommentKey('a', 'node'), nodeCommentKey('b', 'node'))
  assert.equal(nodeCommentKey(null, 'node'), '')
  assert.equal(nodeCommentKey('game', null), '')
})

test('unsent and in-flight comment drafts remain dirty until acknowledged', async () => {
  const pending = deferred<{ comment: string }>()
  const queue = createNodeCommentQueue(() => pending.promise)
  assert.equal(queue.hasDrafts(), false)
  queue.set('game/node', 'node', 'new comment')
  const saving = queue.flush()
  await Promise.resolve()
  assert.equal(queue.hasDrafts(), true)
  pending.resolve({ comment: 'new comment' })
  await saving
  assert.equal(queue.hasDrafts(), false)
})

test('pending edits are coalesced and empty comments are saved', async () => {
  const saved: string[] = []
  const queue = createNodeCommentQueue(async update => {
    saved.push(update.comment)
    return { comment: update.comment }
  })
  queue.set('key', 'node', 'old')
  queue.set('key', 'node', '')
  assert.equal(queue.get('key'), '')
  await queue.flush()
  assert.deepEqual(saved, [''])
  assert.equal(queue.get('key'), undefined)
})

test('in-flight replies cannot acknowledge a newer edit, even with identical text', async () => {
  const first = deferred<{ comment: string }>()
  const started = deferred<void>()
  const sent: string[] = []
  const accepted: string[] = []
  const queue = createNodeCommentQueue(async update => {
    sent.push(update.comment)
    if (sent.length === 1) { started.resolve(); return first.promise }
    return { comment: 'latest' }
  }, (_, comment) => accepted.push(comment))
  queue.set('key', 'node', 'A')
  const saving = queue.flush()
  await started.promise
  queue.set('key', 'node', 'B')
  queue.set('key', 'node', 'A')
  const alsoSaving = queue.flush()
  first.resolve({ comment: 'stale' })
  await Promise.all([saving, alsoSaving])
  assert.deepEqual(sent, ['A', 'A'])
  assert.deepEqual(accepted, ['latest'])
})

test('save failures preserve failed and unsent drafts for retry', async () => {
  let unavailable = true
  const saved: string[] = []
  const queue = createNodeCommentQueue(async update => {
    if (unavailable) throw new Error('unavailable')
    saved.push(update.nodeId)
    return { comment: update.comment }
  })
  queue.set('a', 'first', 'one')
  queue.set('b', 'second', 'two')
  await assert.rejects(queue.flush(), /unavailable/)
  assert.equal(queue.get('a'), 'one')
  assert.equal(queue.get('b'), 'two')
  unavailable = false
  await queue.flush()
  assert.deepEqual(saved.sort(), ['first', 'second'])
  assert.equal(queue.get('a'), undefined)
  assert.equal(queue.get('b'), undefined)
})

test('a failed older save cannot replace newer pending text', async () => {
  const first = deferred<{ comment: string }>()
  const started = deferred<void>()
  const sent: string[] = []
  const queue = createNodeCommentQueue(async update => {
    sent.push(update.comment)
    if (sent.length === 1) { started.resolve(); return first.promise }
    return { comment: update.comment }
  })
  queue.set('key', 'node', 'old')
  const saving = queue.flush()
  await started.promise
  queue.set('key', 'node', 'new')
  const rejected = assert.rejects(saving, /failed/)
  first.reject(new Error('failed'))
  await rejected
  await queue.flush()
  assert.deepEqual(sent, ['old', 'new'])
})

test('discard cancels unsent drafts and suppresses an in-flight acknowledgement', async () => {
  const first = deferred<{ comment: string }>()
  const started = deferred<void>()
  const sent: string[] = []
  const accepted: string[] = []
  const queue = createNodeCommentQueue(async update => {
    sent.push(update.nodeId)
    started.resolve()
    return first.promise
  }, (_, comment) => accepted.push(comment))
  queue.set('a', 'first', 'one')
  queue.set('b', 'second', 'two')
  const saving = queue.flush()
  await started.promise
  queue.discard('a')
  queue.discard('b')
  first.resolve({ comment: 'old reply' })
  await saving
  assert.deepEqual(sent, ['first'])
  assert.deepEqual(accepted, [])
})

test('clearing a game prevents a failed request from resurrecting its drafts', async () => {
  const first = deferred<{ comment: string }>()
  const started = deferred<void>()
  let calls = 0
  const queue = createNodeCommentQueue(async update => {
    calls++
    if (calls === 1) { started.resolve(); return first.promise }
    return { comment: update.comment }
  })
  queue.set('old', 'node', 'old game')
  const saving = queue.flush()
  await started.promise
  queue.clear()
  queue.set('new', 'node', 'new game')
  const rejected = assert.rejects(saving, /failed/)
  first.reject(new Error('failed'))
  await rejected
  await queue.flush()
  assert.equal(calls, 2)
  assert.equal(queue.get('old'), undefined)
})
