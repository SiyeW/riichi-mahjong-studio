const WORKSPACE_ITEM_IDS = Object.freeze([
  'table',
  'console',
  'analysis-opponents',
  'analysis-game',
  'analysis-risk',
  'analysis-counts',
])

function item(id) {
  return { type: 'item', id }
}

function positiveWeight(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1
}

function split(direction, children, weights = children.map(() => 1)) {
  return {
    type: 'split',
    direction,
    children,
    weights: children.map((_, index) => positiveWeight(weights[index])),
  }
}

function normalizeLegacyOrder(value) {
  const valid = ['table', 'analysis', 'console']
  const requested = Array.isArray(value) ? value : []
  const order = [...new Set(requested.filter((entry) => valid.includes(entry)))]
  for (const entry of valid) {
    if (!order.includes(entry)) order.push(entry)
  }
  return order
}

function createDefaultDockLayout(legacyOrder) {
  const mainChildren = []
  const mainWeights = []
  for (const id of normalizeLegacyOrder(legacyOrder)) {
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

function normalizeDockNode(value, seen, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 16) return null
  if (value.type === 'item') {
    if (!WORKSPACE_ITEM_IDS.includes(value.id) || seen.has(value.id)) return null
    seen.add(value.id)
    return item(value.id)
  }
  if (value.type !== 'split') return null
  const direction = value.direction === 'vertical' ? 'vertical' : value.direction === 'horizontal' ? 'horizontal' : null
  if (!direction || !Array.isArray(value.children)) return null
  const rawWeights = Array.isArray(value.weights) ? value.weights : []
  const entries = value.children.flatMap((child, index) => {
    const normalized = normalizeDockNode(child, seen, depth + 1)
    return normalized ? [{ node: normalized, weight: positiveWeight(rawWeights[index]) }] : []
  })
  if (!entries.length) return null
  if (entries.length === 1) return entries[0].node
  return split(direction, entries.map((entry) => entry.node), entries.map((entry) => entry.weight))
}

function containsDockItem(node, id) {
  return node.type === 'item' ? node.id === id : node.children.some((child) => containsDockItem(child, id))
}

function insertDockItem(node, inserted, target, edge) {
  const direction = edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical'
  const insertBefore = edge === 'left' || edge === 'top'
  if (node.type === 'item') {
    if (node.id !== target) return null
    return split(direction, insertBefore ? [inserted, node] : [node, inserted])
  }
  const targetIndex = node.children.findIndex((child) => containsDockItem(child, target))
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

function addMissingDockItems(layout) {
  if (!containsDockItem(layout, 'table')) return createDefaultDockLayout()
  let next = layout
  const placements = [
    ['console', 'table', 'left'],
    ['analysis-opponents', 'table', 'right'],
    ['analysis-game', 'analysis-opponents', 'bottom'],
    ['analysis-risk', 'table', 'bottom'],
    ['analysis-counts', 'analysis-risk', 'right'],
  ]
  for (const [id, target, edge] of placements) {
    if (containsDockItem(next, id)) continue
    const insertionTarget = containsDockItem(next, target) ? target : 'table'
    next = insertDockItem(next, item(id), insertionTarget, edge) || next
  }
  return next
}

function normalizeWorkspaceDockLayout(value, legacyOrder) {
  const normalized = normalizeDockNode(value, new Set())
  return normalized ? addMissingDockItems(normalized) : createDefaultDockLayout(legacyOrder)
}

module.exports = {
  WORKSPACE_ITEM_IDS,
  createDefaultDockLayout,
  normalizeWorkspaceDockLayout,
}
