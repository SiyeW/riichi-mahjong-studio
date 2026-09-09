import assert from 'node:assert/strict'
import test from 'node:test'
import { playPrefetchPositionKey, usePlayPrefetch } from './usePlayPrefetch.ts'
import type { EnvironmentResponse } from './contracts/runtime.ts'

test('prefetch position keys require both game and node identity', () => {
  assert.equal(playPrefetchPositionKey('game', 'node'), 'game\u0000node')
  assert.equal(playPrefetchPositionKey('', 'node'), null)
  assert.equal(playPrefetchPositionKey('game', null), null)
})

test('an early ready event is retained for its position and consumed by the matching response', () => {
  const current = { gameId: 'game', nodeId: 'current' }
  let changes = 0
  const prefetch = usePlayPrefetch({
    currentPosition: () => current,
    onCurrentStatusChanged: () => { changes += 1 },
  })

  prefetch.markPlayPrefetchReady('game', 'next')
  assert.equal(prefetch.playPrefetchReady.value, false)
  current.nodeId = 'next'
  prefetch.applyPlayPrefetchStatus({ ready: false, waiting: true } as EnvironmentResponse['playPrefetch'])
  assert.equal(prefetch.playPrefetchReady.value, true)
  assert.equal(prefetch.playPrefetchWaiting.value, false)
  assert.equal(changes, 1)
})

test('the current ready event updates immediately and advancement consumes it', () => {
  const current = { gameId: 'game', nodeId: 'node' }
  let changes = 0
  const prefetch = usePlayPrefetch({
    currentPosition: () => current,
    onCurrentStatusChanged: () => { changes += 1 },
  })

  prefetch.markPlayPrefetchReady('game', 'node')
  assert.equal(prefetch.playPrefetchReady.value, true)
  assert.equal(changes, 1)
  prefetch.beginPlayPrefetchAdvance()
  assert.equal(prefetch.playPrefetchReady.value, false)
  prefetch.applyPlayPrefetchStatus({ ready: false, waiting: true } as EnvironmentResponse['playPrefetch'])
  assert.equal(prefetch.playPrefetchReady.value, false)
  assert.equal(prefetch.playPrefetchWaiting.value, true)
})

test('reset discards queued readiness and clears the current status', () => {
  const current = { gameId: 'game', nodeId: 'current' }
  const prefetch = usePlayPrefetch({
    currentPosition: () => current,
    onCurrentStatusChanged: () => {},
  })
  prefetch.markPlayPrefetchReady('game', 'next')
  prefetch.applyPlayPrefetchStatus({ ready: true, waiting: false } as EnvironmentResponse['playPrefetch'])
  prefetch.resetPlayPrefetch()
  current.nodeId = 'next'
  prefetch.activatePlayPrefetchPosition('game', 'next')
  assert.equal(prefetch.playPrefetchReady.value, false)
  assert.equal(prefetch.playPrefetchWaiting.value, false)
})
