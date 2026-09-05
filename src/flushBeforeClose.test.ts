import assert from 'node:assert/strict'
import test from 'node:test'
import { flushBeforeClose } from './flushBeforeClose.ts'

test('close waits for both comments and engine configuration', async () => {
  const saved: string[] = []
  await flushBeforeClose(
    async () => { saved.push('comments') },
    async () => { saved.push('engines'); return true },
    () => 'failed',
  )
  assert.deepEqual(saved.sort(), ['comments', 'engines'])
})

test('a false engine save result blocks closing', async () => {
  await assert.rejects(flushBeforeClose(async () => {}, async () => false, () => 'engine save failed'), /engine save failed/)
})

test('a comment failure still waits for the engine save to settle', async () => {
  let release!: (value: boolean) => void
  let engineStarted!: () => void
  const started = new Promise<void>(resolve => { engineStarted = resolve })
  const engine = new Promise<boolean>(resolve => { release = resolve })
  let finished = false
  const closing = flushBeforeClose(
    async () => { throw new Error('comment failed') },
    () => { engineStarted(); return engine },
    () => 'engine failed',
  )
  const checked = assert.rejects(closing, /comment failed/).then(() => { finished = true })
  await started
  assert.equal(finished, false)
  release(true)
  await checked
})

test('synchronous save errors do not prevent the other save from running', async () => {
  let commentsSaved = false
  await assert.rejects(flushBeforeClose(
    async () => { commentsSaved = true },
    () => { throw new Error('engine failed') },
    () => 'failed',
  ), /engine failed/)
  assert.equal(commentsSaved, true)
})
