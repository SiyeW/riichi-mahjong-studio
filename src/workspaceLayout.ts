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

export type WorkspaceDockViewNode =
  | { type: 'item'; id: WorkspaceItemId }
  | {
      type: 'split'
      direction: DockDirection
      children: WorkspaceDockViewNode[]
      weights: number[]
      sourcePath: number[]
      sourceChildIndexes: number[]
    }

export interface DockResizeRequest {
  direction: DockDirection
  sourcePath: number[]
  beforeIndex: number
  afterIndex: number
  beforeItems: WorkspaceItemId[]
  afterItems: WorkspaceItemId[]
  beforeSize: number
  afterSize: number
  event: PointerEvent
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

function dockSizeFraction(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 && numeric < 1
    ? Math.max(0.08, Math.min(0.8, numeric))
    : null
}

function insertedDockWeight(
  children: readonly WorkspaceDockNode[],
  weights: readonly number[],
  insertedFraction: unknown,
  visibleItems?: ReadonlySet<WorkspaceItemId>,
): number | null {
  const fraction = dockSizeFraction(insertedFraction)
  if (fraction === null) return null
  const existingWeight = weights.reduce((total, weight, index) => {
    const child = children[index]
    if (visibleItems && child && !dockNodeItemIds(child).some((id) => visibleItems.has(id))) return total
    return total + positiveWeight(weight)
  }, 0)
  return existingWeight * fraction / (1 - fraction)
}

function preferredDockWeight(id: WorkspaceItemId, direction: DockDirection): number {
  if (direction === 'horizontal') {
    if (id === 'table') return 1.8
    if (id === 'console') return 0.78
    return 1.2
  }
  if (id === 'table') return 2
  if (id === 'console') return 0.8
  return 1
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

function dockNodeItemIds(node: WorkspaceDockNode): WorkspaceItemId[] {
  return node.type === 'item' ? [node.id] : node.children.flatMap(dockNodeItemIds)
}

function dockNodeAtPath(
  node: WorkspaceDockNode,
  sourcePath: readonly number[],
): WorkspaceDockNode | null {
  if (!sourcePath.length) return node
  if (node.type !== 'split') return null
  const [childIndex, ...remainingPath] = sourcePath
  const child = node.children[childIndex]
  return child ? dockNodeAtPath(child, remainingPath) : null
}

function sameDockItems(node: WorkspaceDockNode, expectedItems: ReadonlySet<WorkspaceItemId>): boolean {
  const nodeItems = dockNodeItemIds(node)
  return nodeItems.length === expectedItems.size
    && nodeItems.every((id) => expectedItems.has(id))
}

function preferredDockNodeWeight(node: WorkspaceDockNode, direction: DockDirection): number {
  const ids = dockNodeItemIds(node)
  if (ids.includes('table')) return preferredDockWeight('table', direction)
  if (ids.includes('console')) return preferredDockWeight('console', direction)
  return preferredDockWeight(ids[0] || 'analysis-opponents', direction)
}

function insertDockItemBesideGroup(
  node: WorkspaceDockNode,
  inserted: WorkspaceDockNode,
  targetItems: ReadonlySet<WorkspaceItemId>,
  edge: DockEdge,
  insertedFraction?: number,
  visibleItems?: ReadonlySet<WorkspaceItemId>,
): WorkspaceDockNode | null {
  const direction: DockDirection = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical'
  const insertBefore = edge === 'left' || edge === 'top'
  if (sameDockItems(node, targetItems)) {
    const targetWeight = preferredDockNodeWeight(node, direction)
    const fraction = dockSizeFraction(insertedFraction)
    const insertedWeight = fraction === null
      ? preferredDockNodeWeight(inserted, direction)
      : fraction
    const resolvedTargetWeight = fraction === null ? targetWeight : 1 - fraction
    return split(
      direction,
      insertBefore ? [inserted, node] : [node, inserted],
      insertBefore
        ? [insertedWeight, resolvedTargetWeight]
        : [resolvedTargetWeight, insertedWeight],
    )
  }
  if (node.type === 'item') return null
  const targetIndex = node.children.findIndex((child) => sameDockItems(child, targetItems))
  if (targetIndex >= 0 && node.direction === direction) {
    const children = [...node.children]
    const weights = [...node.weights]
    const insertionIndex = targetIndex + (insertBefore ? 0 : 1)
    const rememberedWeight = insertedDockWeight(
      node.children,
      node.weights,
      insertedFraction,
      visibleItems,
    )
    const targetWeight = positiveWeight(node.weights[targetIndex])
    const targetPreferredWeight = preferredDockNodeWeight(node.children[targetIndex], direction)
    const insertedWeight = rememberedWeight ?? (
      targetWeight * preferredDockNodeWeight(inserted, direction) / targetPreferredWeight
    )
    children.splice(insertionIndex, 0, inserted)
    weights.splice(insertionIndex, 0, insertedWeight)
    return split(direction, children, weights)
  }
  for (let index = 0; index < node.children.length; index += 1) {
    const nested = insertDockItemBesideGroup(
      node.children[index],
      inserted,
      targetItems,
      edge,
      insertedFraction,
      visibleItems,
    )
    if (!nested) continue
    const children = [...node.children]
    children[index] = nested
    return split(node.direction, children, node.weights)
  }
  return null
}

function insertDockItem(
  node: WorkspaceDockNode,
  inserted: WorkspaceDockNode,
  target: WorkspaceItemId,
  edge: DockEdge,
  insertedFraction?: number,
  visibleItems?: ReadonlySet<WorkspaceItemId>,
): WorkspaceDockNode | null {
  const direction: DockDirection = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical'
  const insertBefore = edge === 'left' || edge === 'top'
  if (node.type === 'item') {
    if (node.id !== target) return null
    const insertedId = inserted.type === 'item' ? inserted.id : target
    const fraction = dockSizeFraction(insertedFraction)
    const insertedWeight = fraction ?? preferredDockWeight(insertedId, direction)
    const targetWeight = fraction === null ? preferredDockWeight(node.id, direction) : 1 - fraction
    const weights = insertBefore
      ? [insertedWeight, targetWeight]
      : [targetWeight, insertedWeight]
    return split(direction, insertBefore ? [inserted, node] : [node, inserted], weights)
  }

  const targetIndex = node.children.findIndex((child) => dockLayoutContains(child, target))
  if (targetIndex < 0) return null
  const targetChild = node.children[targetIndex]
  if (node.direction === direction && targetChild.type === 'item') {
    const children = [...node.children]
    const weights = [...node.weights]
    const insertionIndex = targetIndex + (insertBefore ? 0 : 1)
    const rememberedWeight = insertedDockWeight(
      node.children,
      node.weights,
      insertedFraction,
      visibleItems,
    )
    const targetWeight = positiveWeight(node.weights[targetIndex])
    const insertedId = inserted.type === 'item' ? inserted.id : target
    const insertedWeight = rememberedWeight ?? (
      targetWeight * preferredDockWeight(insertedId, direction) / preferredDockWeight(target, direction)
    )
    children.splice(insertionIndex, 0, inserted)
    weights.splice(insertionIndex, 0, insertedWeight)
    return split(direction, children, weights)
  }

  const nested = insertDockItem(
    targetChild,
    inserted,
    target,
    edge,
    insertedFraction,
    visibleItems,
  )
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
  insertedFraction?: number,
  visibleItems?: ReadonlySet<WorkspaceItemId>,
): WorkspaceDockNode {
  if (id === 'table' || id === target || !dockLayoutContains(layout, id) || !dockLayoutContains(layout, target)) {
    return layout
  }
  const withoutItem = removeDockItem(layout, id)
  if (!withoutItem || !dockLayoutContains(withoutItem, target)) return layout
  return insertDockItem(
    withoutItem,
    item(id),
    target,
    edge,
    insertedFraction,
    visibleItems,
  ) || layout
}

export function moveDockItemBesideNode(
  layout: WorkspaceDockNode,
  id: WorkspaceItemId,
  targetPath: readonly number[],
  edge: DockEdge,
  insertedFraction?: number,
  visibleItems?: ReadonlySet<WorkspaceItemId>,
): WorkspaceDockNode {
  if (id === 'table' || !dockLayoutContains(layout, id)) return layout
  const targetNode = dockNodeAtPath(layout, targetPath)
  if (!targetNode) return layout
  const targetItems = new Set(dockNodeItemIds(targetNode).filter((targetId) => targetId !== id))
  if (!targetItems.size) return layout
  const withoutItem = removeDockItem(layout, id)
  if (!withoutItem || [...targetItems].some((targetId) => !dockLayoutContains(withoutItem, targetId))) return layout
  return insertDockItemBesideGroup(
    withoutItem,
    item(id),
    targetItems,
    edge,
    insertedFraction,
    visibleItems,
  ) || layout
}

export function resizeDockSplit(
  layout: WorkspaceDockNode,
  sourcePath: readonly number[],
  beforeIndex: number,
  afterIndex: number,
  beforeFraction: number,
): WorkspaceDockNode {
  if (!sourcePath.length) {
    if (layout.type !== 'split') return layout
    if (!layout.children[beforeIndex] || !layout.children[afterIndex]) return layout
    const pairWeight = positiveWeight(layout.weights[beforeIndex]) + positiveWeight(layout.weights[afterIndex])
    const fraction = Math.max(0.01, Math.min(0.99, Number(beforeFraction) || 0.5))
    const weights = [...layout.weights]
    weights[beforeIndex] = pairWeight * fraction
    weights[afterIndex] = pairWeight * (1 - fraction)
    return split(layout.direction, layout.children, weights)
  }
  if (layout.type !== 'split') return layout
  const [childIndex, ...remainingPath] = sourcePath
  if (!layout.children[childIndex]) return layout
  const resizedChild = resizeDockSplit(
    layout.children[childIndex],
    remainingPath,
    beforeIndex,
    afterIndex,
    beforeFraction,
  )
  if (resizedChild === layout.children[childIndex]) return layout
  const children = [...layout.children]
  children[childIndex] = resizedChild
  return split(layout.direction, children, layout.weights)
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
  sourcePath: number[] = [],
): WorkspaceDockViewNode | null {
  if (node.type === 'item') return visibleItems.has(node.id) ? node : null
  const entries = node.children.flatMap((child, index) => {
    const visible = visibleDockLayout(child, visibleItems, [...sourcePath, index])
    return visible ? [{ node: visible, weight: node.weights[index], sourceIndex: index }] : []
  })
  if (!entries.length) return null
  if (entries.length === 1) return entries[0].node
  return {
    type: 'split',
    direction: node.direction,
    children: entries.map((entry) => entry.node),
    weights: entries.map((entry) => positiveWeight(entry.weight)),
    sourcePath,
    sourceChildIndexes: entries.map((entry) => entry.sourceIndex),
  }
}
