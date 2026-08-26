export const WORKSPACE_ITEM_IDS = [
  'table',
  'console',
  'analysis-opponents',
  'analysis-game',
  'analysis-risk',
  'analysis-counts',
] as const

export type WorkspaceItemId = typeof WORKSPACE_ITEM_IDS[number]
export type AnalysisPanelId = Extract<WorkspaceItemId, `analysis-${string}`>
export type DockDirection = 'horizontal' | 'vertical'
export type DockEdge = 'left' | 'right' | 'top' | 'bottom'

export type WorkspaceDockNode =
  | { type: 'item'; id: WorkspaceItemId }
  | {
      type: 'split'
      direction: DockDirection
      children: WorkspaceDockNode[]
      weights: number[]
    }

const item = (id: WorkspaceItemId): WorkspaceDockNode => ({ type: 'item', id })

function split(
  direction: DockDirection,
  children: WorkspaceDockNode[],
  weights = children.map(() => 1),
): WorkspaceDockNode {
  return {
    type: 'split',
    direction,
    children,
    weights: children.map((_, index) => positiveWeight(weights[index])),
  }
}

function positiveWeight(value: unknown): number {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1
}

function legacyWorkspaceOrder(value: unknown): Array<'table' | 'analysis' | 'console'> {
  const valid = ['table', 'analysis', 'console'] as const
  const requested = Array.isArray(value) ? value : []
  const order = requested.filter((entry): entry is typeof valid[number] => (
    typeof entry === 'string' && valid.includes(entry as typeof valid[number])
  )).filter((entry, index, entries) => entries.indexOf(entry) === index)
  for (const entry of valid) {
    if (!order.includes(entry)) order.push(entry)
  }
  return order
}

export function createDefaultDockLayout(legacyOrder?: unknown): WorkspaceDockNode {
  const mainChildren: WorkspaceDockNode[] = []
  const mainWeights: number[] = []
  for (const id of legacyWorkspaceOrder(legacyOrder)) {
    if (id === 'table') {
      mainChildren.push(item('table'))
      mainWeights.push(1.8)
    } else if (id === 'console') {
      mainChildren.push(item('console'))
      mainWeights.push(0.78)
    } else {
      mainChildren.push(split('vertical', [item('analysis-opponents'), item('analysis-game')]))
      mainWeights.push(1.2)
    }
  }
  return split('vertical', [
    split('horizontal', mainChildren, mainWeights),
    split('horizontal', [item('analysis-risk'), item('analysis-counts')]),
  ], [2, 1])
}

function normalizeDockNode(
  value: unknown,
  seen: Set<WorkspaceItemId>,
  depth = 0,
): WorkspaceDockNode | null {
  if (!value || typeof value !== 'object' || depth > 16) return null
  const source = value as Record<string, unknown>
  if (source.type === 'item') {
    const id = source.id
    if (typeof id !== 'string' || !WORKSPACE_ITEM_IDS.includes(id as WorkspaceItemId)) return null
    if (seen.has(id as WorkspaceItemId)) return null
    seen.add(id as WorkspaceItemId)
    return item(id as WorkspaceItemId)
  }
  if (source.type !== 'split') return null
  const direction = source.direction === 'vertical' ? 'vertical' : source.direction === 'horizontal' ? 'horizontal' : null
  if (!direction || !Array.isArray(source.children)) return null
  const rawWeights = Array.isArray(source.weights) ? source.weights : []
  const entries = source.children.flatMap((child, index) => {
    const normalized = normalizeDockNode(child, seen, depth + 1)
    return normalized ? [{ node: normalized, weight: positiveWeight(rawWeights[index]) }] : []
  })
  if (!entries.length) return null
  if (entries.length === 1) return entries[0].node
  return split(direction, entries.map((entry) => entry.node), entries.map((entry) => entry.weight))
}

export function dockLayoutContains(node: WorkspaceDockNode, id: WorkspaceItemId): boolean {
  return node.type === 'item'
    ? node.id === id
    : node.children.some((child) => dockLayoutContains(child, id))
}

function removeDockItem(node: WorkspaceDockNode, id: WorkspaceItemId): WorkspaceDockNode | null {
  if (node.type === 'item') return node.id === id ? null : node
  const entries = node.children.flatMap((child, index) => {
    const next = removeDockItem(child, id)
    return next ? [{ node: next, weight: node.weights[index] }] : []
  })
  if (!entries.length) return null
  if (entries.length === 1) return entries[0].node
  return split(node.direction, entries.map((entry) => entry.node), entries.map((entry) => entry.weight))
}

function insertDockItem(
  node: WorkspaceDockNode,
  inserted: WorkspaceDockNode,
  target: WorkspaceItemId,
  edge: DockEdge,
): WorkspaceDockNode | null {
  const direction: DockDirection = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical'
  const insertBefore = edge === 'left' || edge === 'top'
  if (node.type === 'item') {
    if (node.id !== target) return null
    return split(direction, insertBefore ? [inserted, node] : [node, inserted])
  }

  const targetIndex = node.children.findIndex((child) => dockLayoutContains(child, target))
  if (targetIndex < 0) return null
  const targetChild = node.children[targetIndex]
  if (node.direction === direction && targetChild.type === 'item') {
    const children = [...node.children]
    const weights = [...node.weights]
    const insertionIndex = targetIndex + (insertBefore ? 0 : 1)
    children.splice(insertionIndex, 0, inserted)
    weights.splice(insertionIndex, 0, positiveWeight(node.weights[targetIndex]))
    return split(direction, children, weights)
  }

  const nested = insertDockItem(targetChild, inserted, target, edge)
  if (!nested) return null
  const children = [...node.children]
  children[targetIndex] = nested
  return split(node.direction, children, node.weights)
}

export function moveDockItem(
  layout: WorkspaceDockNode,
  id: WorkspaceItemId,
  target: WorkspaceItemId,
  edge: DockEdge,
): WorkspaceDockNode {
  if (id === 'table' || id === target || !dockLayoutContains(layout, id) || !dockLayoutContains(layout, target)) {
    return layout
  }
  const withoutItem = removeDockItem(layout, id)
  if (!withoutItem || !dockLayoutContains(withoutItem, target)) return layout
  return insertDockItem(withoutItem, item(id), target, edge) || layout
}

function addMissingDockItems(layout: WorkspaceDockNode): WorkspaceDockNode {
  if (!dockLayoutContains(layout, 'table')) return createDefaultDockLayout()
  let next = layout
  const placements: Array<[WorkspaceItemId, WorkspaceItemId, DockEdge]> = [
    ['console', 'table', 'left'],
    ['analysis-opponents', 'table', 'right'],
    ['analysis-game', 'analysis-opponents', 'bottom'],
    ['analysis-risk', 'table', 'bottom'],
    ['analysis-counts', 'analysis-risk', 'right'],
  ]
  for (const [id, target, edge] of placements) {
    if (dockLayoutContains(next, id)) continue
    const insertionTarget = dockLayoutContains(next, target) ? target : 'table'
    next = insertDockItem(next, item(id), insertionTarget, edge) || next
  }
  return next
}

export function normalizeWorkspaceDockLayout(value: unknown, legacyOrder?: unknown): WorkspaceDockNode {
  const normalized = normalizeDockNode(value, new Set())
  return normalized ? addMissingDockItems(normalized) : createDefaultDockLayout(legacyOrder)
}

export function visibleDockLayout(
  node: WorkspaceDockNode,
  visibleItems: ReadonlySet<WorkspaceItemId>,
): WorkspaceDockNode | null {
  if (node.type === 'item') return visibleItems.has(node.id) ? node : null
  const entries = node.children.flatMap((child, index) => {
    const visible = visibleDockLayout(child, visibleItems)
    return visible ? [{ node: visible, weight: node.weights[index] }] : []
  })
  if (!entries.length) return null
  if (entries.length === 1) return entries[0].node
  return split(node.direction, entries.map((entry) => entry.node), entries.map((entry) => entry.weight))
}
