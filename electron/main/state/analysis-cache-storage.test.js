const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const {
  ANALYSIS_CACHE_STORAGE_FIELD,
  compactAnalysisCaches,
  expandAnalysisCaches,
  packJson,
  unpackJson,
} = require('./analysis-cache-storage')

const parityFixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../../../test/fixtures/analysis-cache-storage-v1.json'),
  'utf8',
))

test('binary JSON packing preserves Float64 values, strings, shapes, and exact zeros', () => {
  const source = {
    finite: [0, 0.00000014975917395076976, 0.6132425665855408, -2500.5],
    nested: { value: 4, probability: 0, label: '1m', available: true, missing: null },
    repeated: [{ value: 1, label: '1m' }, { value: 2, label: '1m' }],
  }
  const packed = packJson(source)
  assert.deepEqual(unpackJson(packed), source)
  assert.equal(packed.strings.filter(value => value === 'probability').length, 1)
  assert.equal(packed.strings.filter(value => value === '1m').length, 1)
  assert.notEqual(packed.exactZero, '', 'zero values use an explicit exact-zero bitmap')
})

test('binary JSON packing matches the shared cross-runtime fixture', () => {
  assert.deepEqual(packJson(parityFixture.source), parityFixture.packed)
  assert.deepEqual(unpackJson(parityFixture.packed), parityFixture.source)
})

test('record cache storage follows node order and preserves absent versus empty caches', () => {
  const source = {
    formatVersion: 3,
    game: {
      gameId: 'game-a',
      nodes: {
        a: { children: ['b'], analysisCache: {} },
        b: {
          children: ['c'],
          opponentAnalysisCache: {
            model: {
              outputs: {
                'opponent-deal-in-probability': {
                  players: [{ seat: 1, tiles: { '1m': 0, '2m': 1.4975917395076976e-7 } }],
                },
              },
            },
          },
        },
        c: { children: [] },
      },
    },
  }
  const compact = compactAnalysisCaches(source)
  assert.ok(compact[ANALYSIS_CACHE_STORAGE_FIELD])
  assert.deepEqual(compact[ANALYSIS_CACHE_STORAGE_FIELD].nodeIds, ['a', 'b', 'c'])
  assert.equal(Object.hasOwn(compact.game.nodes.a, 'analysisCache'), false)
  assert.equal(Object.hasOwn(compact.game.nodes.b, 'opponentAnalysisCache'), false)
  assert.equal(Object.hasOwn(compact.game.nodes.c, 'analysisCache'), false)
  assert.deepEqual(expandAnalysisCaches(compact), source)
  assert.deepEqual(source.game.nodes.a.analysisCache, {}, 'compaction does not mutate the live record')
})

test('records without derived caches remain byte-shape compatible', () => {
  const source = { formatVersion: 3, game: { nodes: { a: { children: [] } } } }
  assert.equal(compactAnalysisCaches(source), source)
  assert.equal(expandAnalysisCaches(source), source)
})

test('packed caches reject mismatched trees and unsupported versions', () => {
  const source = {
    game: { nodes: { a: { analysisCache: { result: 1 } } } },
  }
  const compact = compactAnalysisCaches(source)
  compact.game.nodes.b = {}
  assert.throws(() => expandAnalysisCaches(compact), /node order/)
  delete compact.game.nodes.b
  compact[ANALYSIS_CACHE_STORAGE_FIELD].schemaVersion = 99
  assert.throws(() => expandAnalysisCaches(compact), /Unsupported/)
})
