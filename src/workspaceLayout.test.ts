import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKSPACE_ITEM_IDS,
  createDefaultDockLayout,
  dockLayoutContains,
  moveDockItem,
  normalizeWorkspaceDockLayout,
  visibleDockLayout,
  type WorkspaceDockNode,
  type WorkspaceItemId,
} from './workspaceLayout.ts'

function flattenItems(node: WorkspaceDockNode): WorkspaceItemId[] {
  return node.type === 'item' ? [node.id] : node.children.flatMap(flattenItems)
}

function findParent(node: WorkspaceDockNode, id: WorkspaceItemId): WorkspaceDockNode | null {
  if (node.type === 'item') return null
  if (node.children.some((child) => child.type === 'item' && child.id === id)) return node
  for (const child of node.children) {
    const match = findParent(child, id)
    if (match) return match
  }
  return null
}

test('normalization keeps every workspace item exactly once', () => {
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
  assert.deepEqual(flattenItems(normalized).sort(), [...WORKSPACE_ITEM_IDS].sort())
})

test('a panel can dock on every edge of the table without moving the table', () => {
  for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
    const initial = createDefaultDockLayout()
    const moved = moveDockItem(initial, 'analysis-counts', 'table', edge)
    const parent = findParent(moved, 'table')
    assert.ok(parent && parent.type === 'split')
    assert.equal(parent.direction, edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical')
    assert.deepEqual(flattenItems(moved).sort(), [...WORKSPACE_ITEM_IDS].sort())
    assert.equal(dockLayoutContains(initial, 'analysis-counts'), true)
  }
})

test('a panel can dock relative to another panel', () => {
  const moved = moveDockItem(
    createDefaultDockLayout(),
    'console',
    'analysis-game',
    'bottom',
  )
  const parent = findParent(moved, 'analysis-game')
  assert.ok(parent && parent.type === 'split')
  assert.equal(parent.direction, 'vertical')
  assert.deepEqual(flattenItems(parent), ['analysis-opponents', 'analysis-game', 'console'])
})

test('hidden panels collapse visually but keep their saved position', () => {
  const saved = moveDockItem(
    createDefaultDockLayout(),
    'analysis-risk',
    'table',
    'left',
  )
  const visible = visibleDockLayout(saved, new Set<WorkspaceItemId>(['table', 'console']))
  assert.ok(visible)
  assert.deepEqual(flattenItems(visible), ['table', 'console'])
  assert.equal(dockLayoutContains(saved, 'analysis-risk'), true)
})

test('the table remains the fixed docking anchor', () => {
  const initial = createDefaultDockLayout()
  assert.equal(moveDockItem(initial, 'table', 'console', 'left'), initial)
})
