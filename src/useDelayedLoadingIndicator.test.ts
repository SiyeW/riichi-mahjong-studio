import assert from 'node:assert/strict'
import test from 'node:test'
import { createDelayedLoadingIndicator } from './useDelayedLoadingIndicator.ts'

test('superseding pending requests preserve the original delayed episode', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const changes: boolean[] = [], indicator = createDelayedLoadingIndicator(value => changes.push(value))
  indicator.update(true, true)
  t.mock.timers.tick(300)
  indicator.update(true, true)
  t.mock.timers.tick(199)
  assert.deepEqual(changes, [])
  t.mock.timers.tick(1)
  assert.deepEqual(changes, [true])
  indicator.update(true, true)
  t.mock.timers.tick(500)
  assert.deepEqual(changes, [true], 'visible loading cannot flash off on another pending frame')
  indicator.update(false, true)
  assert.deepEqual(changes, [true, false])
  indicator.dispose()
})

test('a resolved/new-scope episode starts a fresh delay; disposal retires pending timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const changes: boolean[] = [], indicator = createDelayedLoadingIndicator(value => changes.push(value))
  indicator.update(true, true); t.mock.timers.tick(400)
  indicator.reset(); indicator.update(true, true); t.mock.timers.tick(499)
  assert.deepEqual(changes, [])
  t.mock.timers.tick(1)
  assert.deepEqual(changes, [true])
  indicator.dispose(); indicator.update(true, false); t.mock.timers.tick(1000)
  assert.deepEqual(changes, [true, false])
})

test('no prior content shows loading immediately; newly retained content cannot restart it', () => {
  const changes: boolean[] = [], indicator = createDelayedLoadingIndicator(value => changes.push(value))
  indicator.update(true, false); indicator.update(true, true)
  assert.deepEqual(changes, [true])
  indicator.update(false, false)
  assert.deepEqual(changes, [true, false])
  indicator.dispose()
})
