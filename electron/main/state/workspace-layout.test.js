const assert = require('node:assert/strict')

const {
  WORKSPACE_ITEM_IDS,
  createDefaultDockLayout,
  normalizeWorkspaceDockLayout,
} = require('./workspace-layout')

function flattenItems(node) {
  return node.type === 'item' ? [node.id] : node.children.flatMap(flattenItems)
}

function testDefaultLayoutContainsEveryPanelOnce() {
  const items = flattenItems(createDefaultDockLayout())
  assert.deepEqual([...items].sort(), [...WORKSPACE_ITEM_IDS].sort())
  assert.equal(new Set(items).size, WORKSPACE_ITEM_IDS.length)
}

function testLegacyOrderControlsMainRow() {
  const layout = createDefaultDockLayout(['console', 'table', 'analysis'])
  assert.equal(layout.type, 'split')
  assert.deepEqual(flattenItems(layout.children[0]), [
    'console',
    'table',
    'analysis-opponents',
    'analysis-game',
  ])
}

function testMalformedLayoutsAreCompletedSafely() {
  const normalized = normalizeWorkspaceDockLayout({
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
  assert.deepEqual([...items].sort(), [...WORKSPACE_ITEM_IDS].sort())
  assert.equal(new Set(items).size, WORKSPACE_ITEM_IDS.length)
}

testDefaultLayoutContainsEveryPanelOnce()
testLegacyOrderControlsMainRow()
testMalformedLayoutsAreCompletedSafely()
console.log('workspace layout tests passed')
