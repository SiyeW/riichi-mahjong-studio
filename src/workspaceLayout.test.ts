import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKSPACE_ITEM_IDS,
  createDefaultDockLayout,
  dockLayoutContains,
  moveDockItem,
  moveDockItemBesideNode,
  normalizeWorkspaceDockLayout,
  resizeDockSplit,
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

test('a panel can dock beside an entire sibling column', () => {
  const layout: WorkspaceDockNode = {
    type: 'split',
    direction: 'horizontal',
    children: [
      { type: 'item', id: 'table' },
      {
        type: 'split',
        direction: 'vertical',
        children: [
          { type: 'item', id: 'analysis-opponents' },
          { type: 'item', id: 'analysis-game' },
          { type: 'item', id: 'analysis-counts' },
        ],
        weights: [1, 1, 1],
      },
      { type: 'item', id: 'console' },
      { type: 'item', id: 'analysis-risk' },
    ],
    weights: [2, 1, 1, 1],
  }
  const moved = moveDockItemBesideNode(layout, 'analysis-counts', [1], 'right', 0.2)
  assert.equal(moved.type, 'split')
  assert.equal(moved.direction, 'horizontal')
  assert.deepEqual(flattenItems(moved.children[1]), ['analysis-opponents', 'analysis-game'])
  assert.deepEqual(flattenItems(moved.children[2]), ['analysis-counts'])
  const totalWeight = moved.weights.reduce((total, weight) => total + weight, 0)
  assert.ok(Math.abs(moved.weights[2] / totalWeight - 0.2) < 0.0001)
  assert.deepEqual(flattenItems(moved).sort(), [...WORKSPACE_ITEM_IDS].sort())
})

test('repeated docking restores a sensible console-to-table width ratio', () => {
  let layout = createDefaultDockLayout()
  layout = moveDockItem(layout, 'console', 'table', 'left')
  layout = moveDockItem(layout, 'console', 'analysis-game', 'bottom')
  layout = moveDockItem(layout, 'console', 'table', 'left')
  const parent = findParent(layout, 'table')
  assert.ok(parent && parent.type === 'split')
  const consoleIndex = parent.children.findIndex((child) => child.type === 'item' && child.id === 'console')
  const tableIndex = parent.children.findIndex((child) => child.type === 'item' && child.id === 'table')
  assert.ok(consoleIndex >= 0 && tableIndex >= 0)
  assert.ok(Math.abs(parent.weights[consoleIndex] / parent.weights[tableIndex] - 0.78 / 1.8) < 0.0001)
})

test('a remembered width is restored when a panel returns to a side', () => {
  let layout = createDefaultDockLayout()
  layout = moveDockItem(layout, 'analysis-counts', 'table', 'bottom', 0.31)
  layout = moveDockItem(layout, 'analysis-counts', 'table', 'right', 0.22)
  assert.equal(layout.type, 'split')
  const row = layout.children.find((child) => (
    child.type === 'split'
      && child.direction === 'horizontal'
      && dockLayoutContains(child, 'table')
      && dockLayoutContains(child, 'analysis-counts')
  ))
  assert.ok(row && row.type === 'split')
  const totalWeight = row.weights.reduce((total, weight) => total + weight, 0)
  const panelIndex = row.children.findIndex((child) => dockLayoutContains(child, 'analysis-counts'))
  assert.ok(panelIndex >= 0)
  assert.ok(Math.abs(row.weights[panelIndex] / totalWeight - 0.22) < 0.0001)
})

test('split resizing preserves the pair total and changes only the selected weights', () => {
  const layout = createDefaultDockLayout()
  assert.equal(layout.type, 'split')
  const top = layout.children[0]
  assert.equal(top.type, 'split')
  const untouchedMiddleWeight = top.weights[1]
  const pairTotal = top.weights[0] + top.weights[2]
  const resized = resizeDockSplit(layout, [0], 0, 2, 0.7)
  assert.equal(resized.type, 'split')
  const resizedTop = resized.children[0]
  assert.equal(resizedTop.type, 'split')
  assert.ok(Math.abs(resizedTop.weights[0] - pairTotal * 0.7) < 0.0001)
  assert.ok(Math.abs(resizedTop.weights[2] - pairTotal * 0.3) < 0.0001)
  assert.equal(resizedTop.weights[1], untouchedMiddleWeight)
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
