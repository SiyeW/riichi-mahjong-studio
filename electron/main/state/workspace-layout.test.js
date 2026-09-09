const assert = require('node:assert/strict')
const test = require('node:test')

const mainProcessLayout = require('./workspace-layout')

function flattenItems(node) {
  return node.type === 'item' ? [node.id] : node.children.flatMap(flattenItems)
}

test('default workspace layout contains every panel once', () => {
  const items = flattenItems(mainProcessLayout.createDefaultDockLayout())
  assert.deepEqual([...items].sort(), [...mainProcessLayout.WORKSPACE_ITEM_IDS].sort())
  assert.equal(new Set(items).size, mainProcessLayout.WORKSPACE_ITEM_IDS.length)
})

test('legacy order controls the main workspace row', () => {
  const layout = mainProcessLayout.createDefaultDockLayout(['console', 'table', 'analysis'])
  assert.equal(layout.type, 'split')
  assert.deepEqual(flattenItems(layout.children[0]), [
    'console',
    'table',
    'analysis-opponents',
    'analysis-game',
  ])
})

test('malformed workspace layouts are completed safely', () => {
  const normalized = mainProcessLayout.normalizeWorkspaceDockLayout({
    type: 'split',
    direction: 'horizontal',
    children: [
      { type: 'item', id: 'table' },
      { type: 'item', id: 'console' },
      { type: 'item', id: 'console' },
      { type: 'item', id: 'unknown' },
    ],
    weights: [3, 1, 99, -2],
  })
  const items = flattenItems(normalized)
  assert.deepEqual([...items].sort(), [...mainProcessLayout.WORKSPACE_ITEM_IDS].sort())
  assert.equal(new Set(items).size, mainProcessLayout.WORKSPACE_ITEM_IDS.length)
})

test('main and renderer workspace normalizers remain equivalent', async () => {
  const rendererLayout = await import('../../../src/workspaceLayout.ts')
  assert.deepEqual(
    mainProcessLayout.WORKSPACE_ITEM_IDS,
    [...rendererLayout.WORKSPACE_ITEM_IDS],
    'workspace item IDs must not drift across process boundaries',
  )

  for (const legacyOrder of [
    undefined,
    [],
    ['console', 'table', 'analysis'],
    ['analysis', 'analysis', 'unknown', 'table'],
  ]) {
    assert.deepEqual(
      mainProcessLayout.createDefaultDockLayout(legacyOrder),
      rendererLayout.createDefaultDockLayout(legacyOrder),
      `default layout differs for legacy order ${JSON.stringify(legacyOrder)}`,
    )
  }

  const fixtures = [
    undefined,
    null,
    false,
    {},
    { type: 'item', id: 'table' },
    {
      type: 'split',
      direction: 'horizontal',
      children: [
        { type: 'item', id: 'table' },
        { type: 'item', id: 'console' },
        { type: 'item', id: 'console' },
        { type: 'item', id: 'unknown' },
      ],
      weights: [3, '2', 99, -2],
    },
    {
      type: 'split',
      direction: 'vertical',
      children: [
        {
          type: 'split',
          direction: 'horizontal',
          children: [
            { type: 'item', id: 'analysis-game' },
            { type: 'item', id: 'table' },
          ],
          weights: [0, 4],
        },
        { type: 'item', id: 'analysis-counts' },
      ],
      weights: [5, 1],
    },
  ]

  for (const fixture of fixtures) {
    assert.deepEqual(
      mainProcessLayout.normalizeWorkspaceDockLayout(fixture),
      rendererLayout.normalizeWorkspaceDockLayout(fixture),
      `normalized layout differs for ${JSON.stringify(fixture)}`,
    )
  }
})
