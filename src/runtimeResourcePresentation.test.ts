import assert from 'node:assert/strict'
import test from 'node:test'
import { runtimeResourceGroups } from './runtimeResourcePresentation.ts'
import type { RuntimeMetrics } from './contracts/runtime.ts'

const MiB = 1024 ** 2
const metrics: RuntimeMetrics = {
  applicationBytes: 800 * MiB, electronBytes: 512 * MiB, backendBytes: 256 * MiB,
  engineBytes: 0, codecBytes: 32 * MiB, backendAvailable: true, electronProcessCount: 3,
  engineProcessCount: 0, systemTotalBytes: 16384 * MiB, systemAvailableBytes: 8192 * MiB,
  sampledAt: 0,
  recordCache: { residentBytes: 16 * MiB, budgetBytes: 32 * MiB, protectedBytes: 2 * MiB,
    protectedOvershootBytes: 0, encodedPendingBytes: 0, pendingResults: 7, queuedWrites: 9, error: null },
}

test('resource groups use separate, explicit references without changing the metrics', () => {
  const original = structuredClone(metrics)
  const [application, system, cache] = runtimeResourceGroups(metrics)
  assert.equal(application!.scaleBytes, 800 * MiB)
  assert.deepEqual(application!.rows.map(row => row.fraction), [0.64, 0.32, 0, 0.04])
  assert.equal(system!.scaleBytes, 16384 * MiB)
  assert.deepEqual(system!.rows.map(row => row.fraction), [0.5, 0.5])
  assert.equal(cache!.scaleBytes, 32 * MiB)
  assert.deepEqual(cache!.rows.map(row => row.fraction), [0.5, 0.0625, 0])
  assert.deepEqual(metrics, original)
})

test('an over-budget cache expands all its rows to the same visible scale', () => {
  const cache = runtimeResourceGroups({ ...metrics, recordCache: { ...metrics.recordCache!,
    residentBytes: 96 * MiB, protectedBytes: 80 * MiB, encodedPendingBytes: 160 * MiB,
    protectedOvershootBytes: 64 * MiB } }).at(-1)!
  assert.equal(cache.referenceBytes, 32 * MiB)
  assert.equal(cache.scaleBytes, 160 * MiB)
  assert.deepEqual(cache.rows.map(row => row.fraction), [0.6, 0.5, 1, 0.4])
})

test('unknown, invalid or zero references never invent filled bars', () => {
  for (const value of [null, -1, NaN, Infinity, 0]) {
    const groups = runtimeResourceGroups({ ...metrics, applicationBytes: value,
      recordCache: { ...metrics.recordCache!, budgetBytes: value as number } })
    assert.ok(groups[0]!.rows.every(row => row.fraction === null))
    assert.ok(groups[2]!.rows.every(row => row.fraction === null))
  }
  const application = runtimeResourceGroups({ ...metrics, backendBytes: null,
    engineBytes: NaN, codecBytes: -1 })[0]!
  assert.deepEqual(application.rows.slice(1).map(row => [row.bytes, row.fraction]), [[null, null], [null, null], [null, null]])
})

test('inconsistent system readings are not displayed as a made-up partition', () => {
  for (const available of [-1, Infinity, metrics.systemTotalBytes + 1]) {
    assert.ok(runtimeResourceGroups({ ...metrics, systemAvailableBytes: available })[1]!.rows
      .every(row => row.bytes === null && row.fraction === null))
  }
})

test('missing readings omit the cache and do not turn counts into byte bars', () => {
  assert.deepEqual(runtimeResourceGroups(null), [])
  assert.equal(runtimeResourceGroups({ ...metrics, recordCache: null }).length, 2)
  assert.deepEqual(runtimeResourceGroups(metrics)[2]!.rows.map(row => row.id), ['resident', 'protected', 'pending'])
})
