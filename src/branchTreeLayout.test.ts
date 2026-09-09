import assert from 'node:assert/strict'
import test from 'node:test'

import {
  branchTreeLayoutCacheKey,
  computeBranchTreeLayout,
  type BranchTreeGeometry,
} from './branchTreeLayout.ts'
import type { GameTreeNode } from './contracts/game.ts'

const geometry: BranchTreeGeometry = {
  baseX: 18,
  baseY: 14,
  columnGap: 14,
  rowGap: 16,
}

function node(
  id: string,
  depth: number,
  parentId: string | null,
  children: string[] = [],
  mainChildId: string | null = null,
): GameTreeNode {
  return {
    id,
    type: 'action',
    parentId,
    children,
    mainChildId,
    action: null,
    depth,
    roundDepth: depth,
  } as GameTreeNode
}

test('branch tree layout keeps the main path in its base column and separates overlapping siblings', () => {
  const nodes = [
    node('root', 1, null, ['main', 'side-a', 'side-b'], 'main'),
    node('main', 2, 'root', ['tail'], 'tail'),
    node('side-a', 2, 'root', ['side-a-tail'], 'side-a-tail'),
    node('side-b', 2, 'root', ['side-b-tail'], 'side-b-tail'),
    node('tail', 3, 'main'),
    node('side-a-tail', 3, 'side-a'),
    node('side-b-tail', 3, 'side-b'),
  ]

  const layout = computeBranchTreeLayout(nodes, 'root', geometry)
  const dots = new Map(layout.dots.map((dot) => [dot.id, dot]))

  assert.equal(dots.get('root')?.x, 18)
  assert.equal(dots.get('main')?.x, 18)
  assert.equal(dots.get('tail')?.x, 18)
  assert.equal(dots.get('side-a')?.x, 32)
  assert.equal(dots.get('side-b')?.x, 46)
  assert.equal(dots.get('side-a')?.y, 30)
  assert.equal(layout.edges.length, nodes.length - 1)
})

test('branch tree layout is a pure calculation and never reorders its input', () => {
  const nodes = [
    node('tail', 3, 'main'),
    node('root', 1, null, ['main'], 'main'),
    node('main', 2, 'root', ['tail'], 'tail'),
  ]
  const originalOrder = nodes.map((entry) => entry.id)

  computeBranchTreeLayout(nodes, 'root', geometry)

  assert.deepEqual(nodes.map((entry) => entry.id), originalOrder)
})

test('layout cache identity includes geometry as well as tree structure', () => {
  const nodes = [node('root', 1, null)]
  const base = branchTreeLayoutCacheKey(nodes, 'root', geometry)
  const resized = branchTreeLayoutCacheKey(nodes, 'root', { ...geometry, rowGap: 20 })

  assert.notEqual(base, resized)
  assert.equal(base, branchTreeLayoutCacheKey(nodes, 'root', { ...geometry }))
})
