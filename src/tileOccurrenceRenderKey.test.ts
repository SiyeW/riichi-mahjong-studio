import assert from 'node:assert/strict'
import test from 'node:test'
import { tileOccurrenceRenderKey } from './tileOccurrenceRenderKey.ts'

test('tile render keys remain stable when another tile is removed', () => {
  const before = ['1m', '2m', '2m', '3m']
  const after = ['1m', '2m', '2m']
  const beforeKeys = before.map((_, index) => tileOccurrenceRenderKey(before, index, 'hand'))
  const afterKeys = after.map((_, index) => tileOccurrenceRenderKey(after, index, 'hand'))

  assert.deepEqual(beforeKeys, ['hand-1m-0', 'hand-2m-0', 'hand-2m-1', 'hand-3m-0'])
  assert.deepEqual(afterKeys, beforeKeys.slice(0, 3))
})

test('duplicate tile keys distinguish occurrences without depending on position', () => {
  const tiles = ['5m', '5m', '5mr', '5m']
  assert.deepEqual(
    tiles.map((_, index) => tileOccurrenceRenderKey(tiles, index, 'hand')),
    ['hand-5m-0', 'hand-5m-1', 'hand-5mr-0', 'hand-5m-2'],
  )
})
