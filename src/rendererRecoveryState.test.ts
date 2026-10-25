import assert from 'node:assert/strict'
import test from 'node:test'
import { createRendererRecoveryState } from './rendererRecoveryState.ts'

test('recovery waits for pending edits and coalesces repeated reload requests', async () => {
  const calls: string[] = []
  const recovery = createRendererRecoveryState(() => { calls.push('reload') })
  let finish!: () => void
  recovery.setFlush(() => new Promise<void>(resolve => {
    calls.push('flush')
    finish = resolve
  }))
  const pending = recovery.recover()
  assert.equal(recovery.recover(), pending)
  await Promise.resolve()
  assert.deepEqual(calls, ['flush'])
  finish()
  await pending
  assert.deepEqual(calls, ['flush', 'reload'])
})

test('failed pending edits prevent reload and permit retry with the replacement root', async () => {
  let reloads = 0
  const recovery = createRendererRecoveryState(() => { reloads++ })
  recovery.setFlush(async () => { throw new Error('backend unavailable') })
  await assert.rejects(recovery.recover(), /backend unavailable/)
  assert.equal(reloads, 0)
  recovery.setFlush(() => {})
  await recovery.recover()
  assert.equal(reloads, 1)
})

test('failure before the root has mounted can reload without pending edits', async () => {
  let reloaded = false
  const recovery = createRendererRecoveryState(() => { reloaded = true })
  await recovery.recover()
  assert.equal(reloaded, true)
})
