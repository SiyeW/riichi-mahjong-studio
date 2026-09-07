import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildWallTileRows,
  encodeWallClipboardTile,
  parseWallClipboardText,
  type WallTile,
} from './useWallView.ts'

test('wall clipboard encoding round-trips honors and red fives', () => {
  const tiles = ['1m', '5mr', '0p', 'E', 'S', 'W', 'N', 'P', 'F', 'C']
  const encoded = tiles.map(encodeWallClipboardTile).join('')
  assert.equal(encoded, '1m0m0p1z2z3z4z5z6z7z')
  assert.deepEqual(parseWallClipboardText(encoded), [
    '1m', '5mr', '5pr', 'E', 'S', 'W', 'N', 'P', 'F', 'C',
  ])
})

test('wall clipboard parser rejects partial or malformed input', () => {
  assert.deepEqual(parseWallClipboardText(''), [])
  assert.deepEqual(parseWallClipboardText('1m 2p ?'), [])
  assert.deepEqual(parseWallClipboardText('8z'), [])
})

test('wall rows preserve the live-wall and dead-wall section boundaries', () => {
  const tiles: WallTile[] = Array.from({ length: 136 }, (_, index) => ({
    index,
    tile: '1m',
    status: 'available',
  }))
  const rows = buildWallTileRows(tiles)
  assert.deepEqual(rows.flat(2).map(({ index }) => index), tiles.map(({ index }) => index))
  assert.deepEqual(rows.map((row) => row.flat().length), [16, 16, 16, 5, 16, 16, 16, 16, 5, 14])
  assert.ok(rows.every((row) => row.length <= 4 && row.every((group) => group.length <= 4)))
})
