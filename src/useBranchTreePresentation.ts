import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type Ref,
} from 'vue'
import { useNextMoveHints } from './useNextMoveHints'

type Translate = (key: string, params?: Record<string, string | number>) => string

export interface TreeDotLayout {
  id: string
  x: number
  y: number
  fill: string
  isControlledAction: boolean
  isMainline: boolean
  shape: 'circle' | 'square'
}

export interface TreeEdgeLayout {
  from: string
  to: string
  d: string
  isMainline: boolean
  minY: number
  maxY: number
}

export interface GraphHitRegion<TDot> {
  dot: TDot
  x: number
  y: number
  width: number | '100%'
  height: number
}

export interface TreeRowLayout {
  depth: number
  nodeId: string
  y: number
  label: string
  isControlledAction: boolean
}

export interface RoundMapDotLayout {
  id: string
  x: number
  y: number
  fill: string
  isCurrent: boolean
  isMainline: boolean
}

export interface RoundMapEdgeLayout {
  from: string
  to: string
  d: string
  stroke: string
  width: number
}

export function useBranchTreePresentation(options: {
  gameView: TrainerGameView
  status: TrainerStatusSnapshot
  settings: TrainerSettings
  uiScale: Readonly<Ref<number>>
  showTreeComparisons: Readonly<Ref<boolean>>
  t: Translate
  formatTreeAction: (action?: Record<string, unknown> | null) => string
  localizedResultTitle: (value: unknown) => string
  relativeSeatLabel: (seat: number) => string
  roundWindLabel: (wind: string) => string
  onCurrentNodeChanged?: () => void
  focusRoundMap: () => void
}) {
  const {
    gameView,
    status,
    settings,
    uiScale,
    showTreeComparisons,
    t,
    formatTreeAction,
    localizedResultTitle,
    relativeSeatLabel,
    roundWindLabel,
    onCurrentNodeChanged,
    focusRoundMap,
  } = options

function buildGraphHitRegions<TDot extends { id: string; x: number; y: number }>(
  dots: TDot[],
  rowHeight: number,
  horizontalRadius: (dot: TDot) => number,
): GraphHitRegion<TDot>[] {
  const dotsByRow = new Map<number, TDot[]>()
  dots.forEach((dot) => {
    const row = dotsByRow.get(dot.y) || []
    row.push(dot)
    dotsByRow.set(dot.y, row)
  })

  return Array.from(dotsByRow.entries())
    .sort(([yA], [yB]) => yA - yB)
    .flatMap(([, rowDots]) => {
      const ordered = rowDots.slice().sort((a, b) => a.x - b.x || a.id.localeCompare(b.id))
      return ordered.map((dot, index) => {
        const nextDot = ordered[index + 1]
        const x = index === 0 ? 0 : Math.max(0, dot.x - horizontalRadius(dot))
        const nextX = nextDot ? Math.max(x, nextDot.x - horizontalRadius(nextDot)) : null
        return {
          dot,
          x,
          y: Math.max(0, dot.y - rowHeight / 2),
          width: nextX === null ? '100%' as const : nextX - x,
          height: rowHeight,
        }
      })
    })
}

function isControlledDecisionNode(node: TrainerTreeNode): boolean {
  return node.isDecision === true
    && Number(node.action?.actor ?? -1) === status.controlledSeat
}

const treeUiScale = computed(() => uiScale.value)
const treeHoveredNodeId = ref<string | null>(null)
const TREE_COL_GAP = computed(() => 14 * treeUiScale.value)
const TREE_ROW_GAP = computed(() => 16 * treeUiScale.value)
const TREE_BASE_X = computed(() => 18 * treeUiScale.value)
const TREE_BASE_Y = computed(() => 14 * treeUiScale.value)
const ROUND_COL_GAP = computed(() => 18 * treeUiScale.value)
const ROUND_ROW_GAP = computed(() => 18 * treeUiScale.value)
const ROUND_BASE_X = computed(() => 18 * treeUiScale.value)
const ROUND_BASE_Y = computed(() => 12 * treeUiScale.value)
const treeBaseX = computed(() => TREE_BASE_X.value)

interface CachedTreeLayoutStatic {
  key: string
  dots: Array<{ id: string; x: number; y: number; col: number }>
  edges: Array<{ from: string; to: string; d: string; minY: number; maxY: number }>
}

const treeLayoutStaticCache = new Map<string, CachedTreeLayoutStatic>()

const treeNodeList = computed(() => {
  const rawNodes = gameView.tree?.nodes
  if (!rawNodes) return [] as TrainerTreeNode[]
  if (Array.isArray(rawNodes)) return rawNodes
  return Object.values(rawNodes)
})

const fullNodeMapById = computed(() => new Map(treeNodeList.value.map((node) => [node.id, node])))
const nodeMapById = fullNodeMapById
const {
  specialNextMoveClass,
  tileNextMoveClass,
} = useNextMoveHints({
  nodeMapById,
  currentNodeId: () => gameView.currentNodeId || null,
  controlledSeat: () => status.controlledSeat,
})

const roundSummaryList = computed(() => gameView.tree?.rounds || [] as TrainerRoundSummary[])

const activeRoundRootId = computed(() => gameView.tree?.currentRoundRootId || null)

const roundTreeNodeList = computed(() => {
  const allowedIds = new Set(treeNodeList.value.map((node) => node.id))
  return treeNodeList.value
    .map((node) => ({
      ...node,
      parentId: node.parentId && allowedIds.has(node.parentId) ? node.parentId : null,
      children: node.children.filter((childId) => allowedIds.has(childId)),
      mainChildId: node.mainChildId && allowedIds.has(node.mainChildId) ? node.mainChildId : null,
    }))
    .sort((a, b) => (
      (a.roundDepth ?? a.depth) - (b.roundDepth ?? b.depth)
      || a.id.localeCompare(b.id)
    ))
})

const roundNodeMapById = computed(() => new Map(roundTreeNodeList.value.map((node) => [node.id, node])))

function getTreeLayoutCacheKey(nodes: TrainerTreeNode[], roundRootId: string) {
  const structure = nodes
    .map((node) => `${node.id}|${node.parentId || ''}|${node.mainChildId || ''}|${(node.children || []).join(',')}|${node.roundDepth ?? node.depth}`)
    .join(';')
  return `${roundRootId}::${treeUiScale.value.toFixed(3)}::${structure}`
}

function computeRoundTreeLayout(nodes: TrainerTreeNode[], roundRootId: string): CachedTreeLayoutStatic {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const rootNode = nodeMap.get(roundRootId)
  if (!rootNode) {
    return { key: `${roundRootId}::empty`, dots: [], edges: [] }
  }

  interface SideBranchSeed {
    childId: string
    parentNodeId: string
    encounterIndex: number
    siblingOrder: number
  }

  interface BranchPlacement {
    id: string
    startNodeId: string
    parentBranchId: string | null
    parentNodeId: string | null
    nodes: string[]
    startRow: number
    endRow: number
    actualStart: number
    reserveStart: number
    parentRow: number
    parentCol: number
    siblingOrder: number
    encounterIndex: number
    col: number
  }

  const branches: BranchPlacement[] = []
  const branchById = new Map<string, BranchPlacement>()
  const nodeBranchId = new Map<string, string>()
  let branchCounter = 0
  let encounterCounter = 0

  function collectBranchNodes(startNodeId: string, branchId: string) {
    const branchNodes: string[] = []
    let currentId = startNodeId
    while (currentId) {
      const node = nodeMap.get(currentId)
      if (!node) break
      branchNodes.push(node.id)
      nodeBranchId.set(node.id, branchId)
      currentId = node.mainChildId || ''
    }
    return branchNodes
  }

  function createBranch(startNodeId: string, parentBranchId: string, parentNodeId: string, encounterIndex: number, siblingOrder: number) {
    const startNode = nodeMap.get(startNodeId)
    if (!startNode) return

    const branchId = `branch-${branchCounter++}`
    const branchNodes = collectBranchNodes(startNodeId, branchId)
    const endDepth = nodeMap.get(branchNodes[branchNodes.length - 1])?.roundDepth ?? startNode.roundDepth ?? startNode.depth
    const parentNode = nodeMap.get(parentNodeId)
    const parentRow = parentNode ? (parentNode.roundDepth ?? parentNode.depth) : (startNode.roundDepth ?? startNode.depth)
    const startRow = startNode.roundDepth ?? startNode.depth

    const branch: BranchPlacement = {
      id: branchId,
      startNodeId,
      parentBranchId,
      parentNodeId,
      nodes: branchNodes,
      startRow,
      endRow: endDepth,
      actualStart: startRow,
      reserveStart: Math.max(1, startRow - 1),
      parentRow,
      parentCol: 0,
      siblingOrder,
      encounterIndex,
      col: -1,
    }

    branches.push(branch)
    branchById.set(branchId, branch)

    const sideSeeds: SideBranchSeed[] = []
    branchNodes.forEach((nodeId) => {
      const node = nodeMap.get(nodeId)
      if (!node) return
      const mainChildId = node.mainChildId
      node.children.forEach((childId, idx) => {
        if (childId !== mainChildId) {
          sideSeeds.push({
            childId,
            parentNodeId: node.id,
            encounterIndex: encounterCounter++,
            siblingOrder: idx,
          })
        }
      })
    })

    sideSeeds.forEach((seed) => {
      createBranch(seed.childId, branchId, seed.parentNodeId, seed.encounterIndex, seed.siblingOrder)
    })
  }

  const mainBranchId = 'branch-main'
  const mainBranchNodes = collectBranchNodes(roundRootId, mainBranchId)
  const mainStartRow = rootNode.roundDepth ?? rootNode.depth
  const mainEndRow = nodeMap.get(mainBranchNodes[mainBranchNodes.length - 1])?.roundDepth ?? mainStartRow
  const mainBranch: BranchPlacement = {
    id: mainBranchId,
    startNodeId: roundRootId,
    parentBranchId: null,
    parentNodeId: null,
    nodes: mainBranchNodes,
    startRow: mainStartRow,
    endRow: mainEndRow,
    actualStart: mainStartRow,
    reserveStart: Math.max(1, mainStartRow - 1),
    parentRow: mainStartRow,
    parentCol: 0,
    siblingOrder: -1,
    encounterIndex: -1,
    col: 0,
  }
  branches.push(mainBranch)
  branchById.set(mainBranchId, mainBranch)

  mainBranchNodes.forEach((nodeId) => {
    const node = nodeMap.get(nodeId)
    if (!node) return
    const mainChildId = node.mainChildId
    node.children.forEach((childId, idx) => {
      if (childId !== mainChildId) {
        createBranch(childId, mainBranchId, node.id, encounterCounter++, idx)
      }
    })
  })

  const nonMainBranches = branches
    .filter((branch) => branch.id !== mainBranchId)
    .sort((a, b) => (
      a.encounterIndex - b.encounterIndex
      || a.startRow - b.startRow
      || a.siblingOrder - b.siblingOrder
    ))

  interface HorizontalReservation {
    row: number
    colStart: number
    colEnd: number
  }

  const horizontalReservations: HorizontalReservation[] = []
  const assignedBranches: BranchPlacement[] = [mainBranch]

  function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
    return aStart <= bEnd && bStart <= aEnd
  }

  function isColumnLegal(branch: BranchPlacement, col: number) {
    for (const placed of assignedBranches) {
      if (placed.id === branch.id || placed.col !== col) continue
      if (intervalsOverlap(branch.reserveStart, branch.endRow, placed.reserveStart, placed.endRow)) {
        return false
      }
    }
    for (const horizontal of horizontalReservations) {
      if (horizontal.colStart <= col && col <= horizontal.colEnd) {
        if (branch.reserveStart <= horizontal.row && horizontal.row <= branch.endRow) {
          return false
        }
      }
    }
    return true
  }

  function isHorizontalLegal(branch: BranchPlacement, col: number) {
    for (const placed of assignedBranches) {
      if (placed.id === branch.id) continue
      if (placed.col <= branch.parentCol || placed.col > col) continue
      if (placed.actualStart <= branch.parentRow && branch.parentRow <= placed.endRow) {
        return false
      }
    }
    return true
  }

  function previousSiblingCol(branch: BranchPlacement) {
    let maxCol = branch.parentCol
    for (const placed of assignedBranches) {
      if (placed.parentNodeId !== branch.parentNodeId) continue
      if (placed.siblingOrder < branch.siblingOrder && placed.col > maxCol) {
        maxCol = placed.col
      }
    }
    return maxCol
  }

  function assignBranchColumns(index: number): boolean {
    if (index >= nonMainBranches.length) return true
    const branch = nonMainBranches[index]
    const parentBranch = branch.parentBranchId ? branchById.get(branch.parentBranchId) : mainBranch
    branch.parentCol = parentBranch?.col ?? 0
    const minCol = Math.max(branch.parentCol + 1, previousSiblingCol(branch) + 1)
    const maxCol = nonMainBranches.length + 1

    for (let col = minCol; col <= maxCol; col += 1) {
      if (!isColumnLegal(branch, col) || !isHorizontalLegal(branch, col)) continue
      branch.col = col
      assignedBranches.push(branch)
      horizontalReservations.push({
        row: branch.parentRow,
        colStart: branch.parentCol,
        colEnd: col,
      })
      if (assignBranchColumns(index + 1)) return true
      horizontalReservations.pop()
      assignedBranches.pop()
      branch.col = -1
    }
    return false
  }

  assignBranchColumns(0)

  const dots = nodes
    .sort((a, b) => (
      (a.roundDepth ?? a.depth) - (b.roundDepth ?? b.depth)
      || ((branchById.get(nodeBranchId.get(a.id) || '')?.col ?? 0) - (branchById.get(nodeBranchId.get(b.id) || '')?.col ?? 0))
      || a.id.localeCompare(b.id)
    ))
    .map((node) => {
      const col = branchById.get(nodeBranchId.get(node.id) || '')?.col ?? 0
      return {
        id: node.id,
        x: TREE_BASE_X.value + col * TREE_COL_GAP.value,
        y: TREE_BASE_Y.value + (((node.roundDepth ?? node.depth) - 1) * TREE_ROW_GAP.value),
        col,
      }
    })

  const placementMap = new Map(dots.map((dot) => [dot.id, dot]))
  const edges = nodes
    .map((node) => {
      if (!node.parentId || !placementMap.has(node.id) || !placementMap.has(node.parentId)) return null
      const parent = placementMap.get(node.parentId)!
      const child = placementMap.get(node.id)!
      return {
        from: node.parentId,
        to: node.id,
        d: parent.col === child.col
          ? `M ${parent.x} ${parent.y} L ${child.x} ${child.y}`
          : `M ${parent.x} ${parent.y} L ${child.x} ${parent.y} L ${child.x} ${child.y}`,
        minY: Math.min(parent.y, child.y),
        maxY: Math.max(parent.y, child.y),
      }
    })
    .filter(Boolean) as CachedTreeLayoutStatic['edges']

  return {
    key: getTreeLayoutCacheKey(nodes, roundRootId),
    dots,
    edges,
  }
}

const treeGraph = computed(() => {
  const nodes = roundTreeNodeList.value
  const roundRootId = activeRoundRootId.value
  if (!nodes.length || !roundRootId) {
    return { dots: [] as TreeDotLayout[], edges: [] as TreeEdgeLayout[] }
  }
  const cacheKey = getTreeLayoutCacheKey(nodes, roundRootId)
  let layout = treeLayoutStaticCache.get(cacheKey)
  if (!layout) {
    layout = computeRoundTreeLayout(nodes, roundRootId)
    treeLayoutStaticCache.set(cacheKey, layout)
    if (treeLayoutStaticCache.size > 12) {
      const firstKey = treeLayoutStaticCache.keys().next().value
      if (firstKey) treeLayoutStaticCache.delete(firstKey)
    }
  }

  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const placements = new Map(layout.dots.map((dot) => [dot.id, dot]))

  const mainlineIds = new Set<string>()
  let cursor = roundRootId
  while (cursor) {
    mainlineIds.add(cursor)
    const node = nodeMap.get(cursor)
    if (!node?.mainChildId) break
    cursor = node.mainChildId
  }

  const dots = nodes
    .map((node) => {
      const placement = placements.get(node.id)
      if (!placement) return null
      const isMainline = mainlineIds.has(node.id)
      const isRoundStart = node.id === roundRootId
      const isRoundTerminal = !!node.phase
        && ['round_result', 'match_end'].includes(node.phase)
        && !node.children.length
      const isControlledAction = isControlledDecisionNode(node)
      const threshold = settings.training.mistakeThreshold
      let fill = isControlledAction ? 'hsl(188, 35%, 44%)' : 'hsl(184, 8%, 46%)'
      if (isControlledAction && showTreeComparisons.value && node.comparison) {
        const c = node.comparison
        const bestP = c.bestProbability || 0
        const raw = bestP > 0
          ? Math.max(0, Math.min(1, c.chosenProbability / bestP))
          : (c.isBest ? 1 : 0)
        if (typeof raw === 'number' && isFinite(raw)) {
          const p = Math.max(0, Math.min(1, raw))
          if (p >= threshold) {
            const t = (p - threshold) / (1 - threshold || 0.001)
            const h = 60 + t * 60
            fill = `hsl(${h}, 70%, 45%)`
          } else {
            const t = p / (threshold || 0.001)
            const h = t * 60
            fill = `hsl(${h}, 75%, 48%)`
          }
        }
      }
      return {
        id: node.id,
        x: placement.x,
        y: placement.y,
        fill,
        isControlledAction,
        isMainline,
        shape: (isRoundStart || isRoundTerminal) ? 'square' : 'circle',
      }
    })
    .filter(Boolean) as TreeDotLayout[]

  const edges: TreeEdgeLayout[] = layout.edges.map((edge) => {
    const isMainlineEdge = mainlineIds.has(edge.to) && mainlineIds.has(edge.from)
    return {
      ...edge,
      isMainline: isMainlineEdge,
    }
  })

  return { dots, edges }
})

const treeDots = computed(() => treeGraph.value.dots)
const treeEdges = computed(() => treeGraph.value.edges)
const treeDotById = computed(() => new Map(treeDots.value.map((dot) => [dot.id, dot])))
const currentTreePathIds = computed(() => {
  const path = new Set<string>()
  let cursor = gameView.currentNodeId || activeRoundRootId.value || ''
  while (cursor) {
    const node = roundNodeMapById.value.get(cursor)
    if (!node) break
    path.add(cursor)
    cursor = node.parentId || ''
  }
  return path
})

const treeDisplayPathIds = computed(() => {
  const nodeMap = roundNodeMapById.value
  const hoveredId = treeHoveredNodeId.value
  const currentId = gameView.currentNodeId || activeRoundRootId.value || ''
  const anchorId = hoveredId && nodeMap.has(hoveredId) ? hoveredId : currentId
  const path = new Set<string>()
  const visited = new Set<string>()

  let cursor = anchorId
  while (cursor && !visited.has(cursor)) {
    const node = nodeMap.get(cursor)
    if (!node) break
    visited.add(cursor)
    path.add(cursor)
    cursor = node.parentId || ''
  }

  cursor = nodeMap.get(anchorId)?.mainChildId || ''
  while (cursor && !visited.has(cursor)) {
    const node = nodeMap.get(cursor)
    if (!node) break
    visited.add(cursor)
    path.add(cursor)
    cursor = node.mainChildId || ''
  }

  return path
})

function formatTreeRowAction(action?: Record<string, unknown> | null) {
  const label = formatTreeAction(action)
  const type = String(action?.type || '')
  return type === 'pon' || type === 'chi'
    ? label.replace(/\s+\([^)]*\)$/, '')
    : label
}

const treeRows = computed<TreeRowLayout[]>(() => {
  const displayPath = treeDisplayPathIds.value
  return roundTreeNodeList.value
    .filter((node) => displayPath.has(node.id))
    .map((node) => {
      const depth = node.roundDepth ?? node.depth
      const dot = treeDotById.value.get(node.id)
      return {
        depth,
        nodeId: node.id,
        y: dot?.y ?? TREE_BASE_Y.value + ((depth - 1) * TREE_ROW_GAP.value),
        label: formatTreeRowAction(node.action),
        isControlledAction: Boolean(dot?.isControlledAction),
      }
    })
    .sort((a, b) => a.depth - b.depth || a.nodeId.localeCompare(b.nodeId))
})

const treeRowActionLabels = computed(() => {
  const labels = Array.from(new Set(
    roundTreeNodeList.value.map((node) => formatTreeRowAction(node.action)),
  ))
  return labels.length ? labels : ['—']
})

const treeCanvasStyle = computed(() => ({
  '--tree-row-height': `${TREE_ROW_GAP.value}px`,
}))

function isCurrentTreeDot(dot: Pick<TreeDotLayout, 'id'>) {
  return dot.id === gameView.currentNodeId
}

function isCurrentTreeEdge(edge: Pick<TreeEdgeLayout, 'from' | 'to'>) {
  const path = currentTreePathIds.value
  return path.has(edge.from) && path.has(edge.to)
}

function treeEdgeStroke(edge: TreeEdgeLayout) {
  if (isCurrentTreeEdge(edge)) return 'rgba(232,246,243,0.88)'
  return edge.isMainline ? 'rgba(159,213,200,0.56)' : 'rgba(159,213,200,0.22)'
}

function treeEdgeWidth(edge: TreeEdgeLayout) {
  const base = isCurrentTreeEdge(edge) ? 2.2 : (edge.isMainline ? 1.5 : 1.2)
  return base * treeUiScale.value
}
const treeSvgW = computed(() => {
  const maxX = Math.max(36 * treeUiScale.value, ...treeDots.value.map((dot) => dot.x))
  return maxX + (20 * treeUiScale.value)
})
const treeSvgH = computed(() => {
  const maxY = Math.max(18 * treeUiScale.value, ...treeDots.value.map((dot) => dot.y))
  return maxY + (18 * treeUiScale.value)
})
const treeHitRegions = computed(() => buildGraphHitRegions(
  treeDots.value,
  TREE_ROW_GAP.value,
  treeDotHorizontalRadius,
))

const treeScrollEl = ref<HTMLElement | null>(null)
const treeViewport = reactive({
  top: 0,
  height: 0,
})
const TREE_RENDER_BUFFER_PX = 160
let treeViewportRaf = 0
let treeAutoFollowSuspended = false

function updateTreeViewport() {
  const el = treeScrollEl.value
  if (!el) {
    treeViewport.top = 0
    treeViewport.height = 0
    return
  }
  treeViewport.top = el.scrollTop
  treeViewport.height = el.clientHeight
}

function onTreeScroll() {
  treeHoveredNodeId.value = null
  if (treeViewportRaf) return
  treeViewportRaf = window.requestAnimationFrame(() => {
    treeViewportRaf = 0
    updateTreeViewport()
  })
}

function keepCurrentTreeDotVisible() {
  const container = treeScrollEl.value
  const currentDot = gameView.currentNodeId ? treeDotById.value.get(gameView.currentNodeId) : null
  if (!container || !currentDot) return
  const padding = 18
  const viewTop = container.scrollTop
  const viewBottom = viewTop + container.clientHeight
  const dotTop = currentDot.y - padding
  const dotBottom = currentDot.y + padding
  if (dotTop < viewTop) {
    container.scrollTop = Math.max(0, dotTop)
  } else if (dotBottom > viewBottom) {
    container.scrollTop = Math.max(0, dotBottom - container.clientHeight)
  }
}

function suspendTreeAutoFollow() {
  treeAutoFollowSuspended = true
}

async function resumeTreeAutoFollow() {
  treeAutoFollowSuspended = false
  await nextTick()
  if (treeAutoFollowSuspended) return
  updateTreeViewport()
  keepCurrentTreeDotVisible()
}

const visibleTreeRange = computed(() => {
  const top = Math.max(0, treeViewport.top - TREE_RENDER_BUFFER_PX)
  const bottom = treeViewport.top + Math.max(treeViewport.height, 0) + TREE_RENDER_BUFFER_PX
  return { top, bottom }
})

const visibleTreeDots = computed(() => {
  const { top, bottom } = visibleTreeRange.value
  return treeDots.value.filter((dot) => dot.y >= top && dot.y <= bottom)
})

const visibleTreeHitRegions = computed(() => {
  const { top, bottom } = visibleTreeRange.value
  return treeHitRegions.value.filter((region) => (
    region.y + region.height >= top && region.y <= bottom
  ))
})

const visibleTreeEdges = computed(() => {
  const { top, bottom } = visibleTreeRange.value
  return treeEdges.value.filter((edge) => edge.maxY >= top && edge.minY <= bottom)
})

const visibleTreeRows = computed(() => {
  const { top, bottom } = visibleTreeRange.value
  return treeRows.value.filter((row) => row.y >= top && row.y <= bottom)
})

const roundMapOverlayOpen = ref(false)
const roundMapHoveredRoundId = ref<string | null>(null)

function openRoundMapOverlay() {
  roundMapOverlayOpen.value = true
  roundMapHoveredRoundId.value = null
  focusRoundMap()
}

function toggleRoundMapOverlay() {
  roundMapOverlayOpen.value = !roundMapOverlayOpen.value
  roundMapHoveredRoundId.value = null
  if (roundMapOverlayOpen.value) focusRoundMap()
}

function closeRoundMapOverlay() {
  roundMapOverlayOpen.value = false
  roundMapHoveredRoundId.value = null
}

const roundRootNodeList = computed(() => (
  roundSummaryList.value
    .slice()
    .sort((a, b) => (
      (a.roundIndex ?? 0) - (b.roundIndex ?? 0)
      || (a.honba ?? 0) - (b.honba ?? 0)
      || a.depth - b.depth
      || a.id.localeCompare(b.id)
    ))
))

function roundSlotKey(node: Pick<TrainerTreeNode, 'roundIndex' | 'honba'>) {
  return `${node.roundIndex ?? -1}:${node.honba ?? 0}`
}

function roundNodeLabel(node: Pick<TrainerTreeNode, 'bakaze' | 'kyoku' | 'honba'>) {
  const bakaze = roundWindLabel(node.bakaze || 'E')
  const kyoku = node.kyoku ?? 0
  const honba = node.honba ?? 0
  return honba > 0 ? `${bakaze}${kyoku}-${honba}` : `${bakaze}${kyoku}`
}

const roundMapRowMeta = computed(() => {
  const uniqueSlots = new Map<string, { key: string; label: string; roundIndex: number; honba: number }>()
  roundRootNodeList.value.forEach((node) => {
    const key = roundSlotKey(node)
    if (!uniqueSlots.has(key)) {
      uniqueSlots.set(key, {
        key,
        label: roundNodeLabel(node),
        roundIndex: node.roundIndex ?? 0,
        honba: node.honba ?? 0,
      })
    }
  })
  const ordered = Array.from(uniqueSlots.values()).sort((a, b) => (
    a.roundIndex - b.roundIndex
    || a.honba - b.honba
    || a.key.localeCompare(b.key)
  ))
  const rowByKey = new Map<string, number>()
  ordered.forEach((slot, index) => rowByKey.set(slot.key, index))
  return { ordered, rowByKey }
})

const roundRootById = computed(() => new Map(roundRootNodeList.value.map((node) => [node.id, node])))

const roundMapHoveredRound = computed(() => (
  roundMapHoveredRoundId.value
    ? roundRootById.value.get(roundMapHoveredRoundId.value) || null
    : null
))

const roundMapCurrentBranchTail = computed(() => {
  let currentId = activeRoundRootId.value
    || roundRootNodeList.value.find((round) => round.isCurrent)?.id
    || roundRootNodeList.value[0]?.id
    || null
  const visited = new Set<string>()
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId)
    const round = roundRootById.value.get(currentId)
    const nextId = round?.mainNextRoundId || null
    if (!nextId || !roundRootById.value.has(nextId)) return round || null
    currentId = nextId
  }
  return currentId ? roundRootById.value.get(currentId) || null : null
})

const roundMapSettlementRound = computed(() => (
  roundMapHoveredRound.value || roundMapCurrentBranchTail.value
))

const roundMapSettlementRoundLabel = computed(() => {
  const round = roundMapSettlementRound.value
  if (!round) return ''
  const kyotaku = Math.max(0, Number(round.kyotaku || 0)) * 1000
  const showKyotaku = Boolean(roundMapHoveredRound.value && round.resultInfo)
  return `${roundNodeLabel(round)}${showKyotaku && kyotaku > 0 ? `　+${kyotaku}` : ''}`
})

const roundMapSettlementTitle = computed(() => {
  const round = roundMapSettlementRound.value
  if (!round) return ''
  const isTerminal = Boolean(round.matchEndInfo) || round.tailPhase === 'match_end'
  if (!roundMapHoveredRound.value) {
    return isTerminal ? t('action.matchEnd') : t('result.inProgress')
  }
  return localizedResultTitle(round.resultInfo?.title)
    || (isTerminal ? t('action.matchEnd') : t('result.inProgress'))
})

const roundMapSettlementLayout = computed(() => {
  const round = roundMapSettlementRound.value
  const hoveringRound = Boolean(roundMapHoveredRound.value)
  const info = hoveringRound ? round?.resultInfo : round?.matchEndInfo
  const scores = info?.scores || round?.tailScores || round?.scores || []
  const hasScores = scores.length >= 4
  const showDelta = Boolean(hoveringRound && info)
  const controlledSeat = status.controlledSeat
  const positions = [
    { position: 'toimen', offset: 2 },
    { position: 'kamicha', offset: 3 },
    { position: 'shimocha', offset: 1 },
    { position: 'self', offset: 0 },
  ] as const
  return positions.map(({ position, offset }) => {
    const seat = (controlledSeat + offset) % 4
    const after = Number(scores[seat] ?? 0)
    const delta = Number(info?.deltas?.[seat] ?? 0)
    return {
      position,
      seat,
      label: relativeSeatLabel(seat),
      hasScores,
      showDelta,
      rank: info?.ranks?.[seat] === undefined ? null : Number(info.ranks[seat]),
      before: after - delta,
      delta,
      after,
    }
  })
})

const roundGraphMeta = computed(() => {
  if (!roundMapOverlayOpen.value) {
    return {
      childRoundIds: new Map<string, string[]>(),
      parentRoundId: new Map<string, string | null>(),
      mainNextRoundId: new Map<string, string | null>(),
      rootRoundId: null as string | null,
    }
  }
  const childRoundIds = new Map<string, string[]>()
  const parentRoundId = new Map<string, string | null>()
  const mainNextRoundId = new Map<string, string | null>()
  roundRootNodeList.value.forEach((roundRoot) => {
    const nextRoundIds = roundRoot.childRoundIds || []
    childRoundIds.set(roundRoot.id, nextRoundIds)
    nextRoundIds.forEach((childRoundId) => {
      if (!parentRoundId.has(childRoundId)) parentRoundId.set(childRoundId, roundRoot.id)
    })
    mainNextRoundId.set(roundRoot.id, roundRoot.mainNextRoundId || null)
  })

  const rootRoundId = roundRootNodeList.value.find((node) => !parentRoundId.has(node.id))?.id || roundRootNodeList.value[0]?.id || null
  return { childRoundIds, parentRoundId, mainNextRoundId, rootRoundId }
})

const roundMapGraph = computed(() => {
  if (!roundMapOverlayOpen.value) {
    return { dots: [] as RoundMapDotLayout[], edges: [] as RoundMapEdgeLayout[], rows: [] as Array<{ key: string; label: string; y: number }> }
  }
  const roundNodes = roundRootNodeList.value
  const { rowByKey, ordered } = roundMapRowMeta.value
  const { childRoundIds, parentRoundId, mainNextRoundId, rootRoundId } = roundGraphMeta.value
  if (!roundNodes.length || !rootRoundId) {
    return { dots: [] as RoundMapDotLayout[], edges: [] as RoundMapEdgeLayout[], rows: [] as Array<{ key: string; label: string; y: number }> }
  }

  const roundNodeMap = roundRootById.value

  interface RoundBranch {
    id: string
    startRoundId: string
    parentBranchId: string | null
    parentRoundId: string | null
    nodes: string[]
    startRow: number
    endRow: number
    reserveStart: number
    parentRow: number
    parentCol: number
    siblingOrder: number
    encounterIndex: number
    col: number
  }

  const branches: RoundBranch[] = []
  const branchById = new Map<string, RoundBranch>()
  const nodeBranchId = new Map<string, string>()
  let branchCounter = 0
  let encounterCounter = 0

  function nodeRow(roundNodeId: string) {
    const roundNode = roundNodeMap.get(roundNodeId)
    return (roundNode ? (rowByKey.get(roundSlotKey(roundNode)) ?? 0) : 0) + 1
  }

  function collectBranchNodes(startRoundId: string, branchId: string) {
    const branchNodes: string[] = []
    let cursorId: string | null = startRoundId
    while (cursorId && roundNodeMap.has(cursorId)) {
      branchNodes.push(cursorId)
      nodeBranchId.set(cursorId, branchId)
      const nextRoundId: string | null = mainNextRoundId.get(cursorId) || null
      if (!nextRoundId) break
      cursorId = nextRoundId
    }
    return branchNodes
  }

  function createBranch(startRoundId: string, parentBranchId: string, parentRoundId: string, encounterIndex: number, siblingOrder: number) {
    if (!roundNodeMap.has(startRoundId)) return
    const branchId = `round-branch-${branchCounter++}`
    const branchNodes = collectBranchNodes(startRoundId, branchId)
    const branch: RoundBranch = {
      id: branchId,
      startRoundId,
      parentBranchId,
      parentRoundId,
      nodes: branchNodes,
      startRow: nodeRow(startRoundId),
      endRow: nodeRow(branchNodes[branchNodes.length - 1]),
      reserveStart: Math.max(1, nodeRow(startRoundId) - 1),
      parentRow: nodeRow(parentRoundId),
      parentCol: 0,
      siblingOrder,
      encounterIndex,
      col: -1,
    }
    branches.push(branch)
    branchById.set(branchId, branch)

    branchNodes.forEach((roundId) => {
      const children = childRoundIds.get(roundId) || []
      const mainChild = mainNextRoundId.get(roundId) || null
      children.forEach((childId, idx) => {
        if (childId !== mainChild) createBranch(childId, branchId, roundId, encounterCounter++, idx)
      })
    })
  }

  const mainBranchId = 'round-branch-main'
  const mainBranchNodes = collectBranchNodes(rootRoundId, mainBranchId)
  const mainBranch: RoundBranch = {
    id: mainBranchId,
    startRoundId: rootRoundId,
    parentBranchId: null,
    parentRoundId: null,
    nodes: mainBranchNodes,
    startRow: nodeRow(rootRoundId),
    endRow: nodeRow(mainBranchNodes[mainBranchNodes.length - 1]),
    reserveStart: Math.max(1, nodeRow(rootRoundId) - 1),
    parentRow: nodeRow(rootRoundId),
    parentCol: 0,
    siblingOrder: -1,
    encounterIndex: -1,
    col: 0,
  }
  branches.push(mainBranch)
  branchById.set(mainBranchId, mainBranch)

  mainBranchNodes.forEach((roundId) => {
    const children = childRoundIds.get(roundId) || []
    const mainChild = mainNextRoundId.get(roundId) || null
    children.forEach((childId, idx) => {
      if (childId !== mainChild) createBranch(childId, mainBranchId, roundId, encounterCounter++, idx)
    })
  })

  const nonMainBranches = branches
    .filter((branch) => branch.id !== mainBranchId)
    .sort((a, b) => a.encounterIndex - b.encounterIndex || a.startRow - b.startRow || a.siblingOrder - b.siblingOrder)

  interface HorizontalReservation { row: number; colStart: number; colEnd: number }
  const horizontalReservations: HorizontalReservation[] = []
  const assignedBranches: RoundBranch[] = [mainBranch]

  function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
    return aStart <= bEnd && bStart <= aEnd
  }

  function isColumnLegal(branch: RoundBranch, col: number) {
    for (const placed of assignedBranches) {
      if (placed.id === branch.id || placed.col !== col) continue
      if (intervalsOverlap(branch.reserveStart, branch.endRow, placed.reserveStart, placed.endRow)) return false
    }
    for (const horizontal of horizontalReservations) {
      if (horizontal.colStart <= col && col <= horizontal.colEnd) {
        if (branch.reserveStart <= horizontal.row && horizontal.row <= branch.endRow) return false
      }
    }
    return true
  }

  function isHorizontalLegal(branch: RoundBranch, col: number) {
    for (const placed of assignedBranches) {
      if (placed.id === branch.id) continue
      if (placed.col <= branch.parentCol || placed.col > col) continue
      if (placed.startRow <= branch.parentRow && branch.parentRow <= placed.endRow) return false
    }
    return true
  }

  function previousSiblingCol(branch: RoundBranch) {
    let maxCol = branch.parentCol
    for (const placed of assignedBranches) {
      if (placed.parentRoundId !== branch.parentRoundId) continue
      if (placed.siblingOrder < branch.siblingOrder && placed.col > maxCol) maxCol = placed.col
    }
    return maxCol
  }

  function assignBranchColumns(index: number): boolean {
    if (index >= nonMainBranches.length) return true
    const branch = nonMainBranches[index]
    const parentBranch = branch.parentBranchId ? branchById.get(branch.parentBranchId) : mainBranch
    branch.parentCol = parentBranch?.col ?? 0
    const minCol = Math.max(branch.parentCol + 1, previousSiblingCol(branch) + 1)
    const maxCol = nonMainBranches.length + 1
    for (let col = minCol; col <= maxCol; col += 1) {
      if (!isColumnLegal(branch, col) || !isHorizontalLegal(branch, col)) continue
      branch.col = col
      assignedBranches.push(branch)
      horizontalReservations.push({ row: branch.parentRow, colStart: branch.parentCol, colEnd: col })
      if (assignBranchColumns(index + 1)) return true
      horizontalReservations.pop()
      assignedBranches.pop()
      branch.col = -1
    }
    return false
  }

  assignBranchColumns(0)

  const placements = new Map<string, { x: number; y: number; col: number }>()
  roundNodes.forEach((node) => {
    const col = branchById.get(nodeBranchId.get(node.id) || '')?.col ?? 0
    const row = rowByKey.get(roundSlotKey(node)) ?? 0
    placements.set(node.id, {
      x: ROUND_BASE_X.value + col * ROUND_COL_GAP.value,
      y: ROUND_BASE_Y.value + row * ROUND_ROW_GAP.value,
      col,
    })
  })

  const mainlineIds = new Set<string>()
  let cursor: string | null = rootRoundId
  while (cursor) {
    mainlineIds.add(cursor)
    cursor = mainNextRoundId.get(cursor) || null
  }

  const currentPathIds = new Set<string>()
  cursor = activeRoundRootId.value
  while (cursor) {
    currentPathIds.add(cursor)
    cursor = parentRoundId.get(cursor) || null
  }

  const dots = roundNodes.map((node) => {
    const placement = placements.get(node.id)!
    return {
      id: node.id,
      x: placement.x,
      y: placement.y,
      fill: 'hsl(188, 35%, 44%)',
      isCurrent: node.id === activeRoundRootId.value,
      isMainline: mainlineIds.has(node.id),
    }
  })

  const edges = roundNodes
    .map((node) => {
      const children = childRoundIds.get(node.id) || []
      return children.map((childId) => {
        const parent = placements.get(node.id)
        const child = placements.get(childId)
        if (!parent || !child) return null
        const isMainline = mainNextRoundId.get(node.id) === childId
        const isCurrentPath = currentPathIds.has(node.id) && currentPathIds.has(childId)
        return {
          from: node.id,
          to: childId,
          d: parent.col === child.col
            ? `M ${parent.x} ${parent.y} L ${child.x} ${child.y}`
            : `M ${parent.x} ${parent.y} L ${child.x} ${parent.y} L ${child.x} ${child.y}`,
          stroke: isCurrentPath
            ? 'rgba(232,246,243,0.88)'
            : (isMainline ? 'rgba(159,213,200,0.56)' : 'rgba(159,213,200,0.22)'),
          width: (isCurrentPath ? 2.2 : (isMainline ? 1.5 : 1.2)) * treeUiScale.value,
        }
      })
    })
    .flat()
    .filter(Boolean) as RoundMapEdgeLayout[]

  const rows = ordered.map((row, index) => ({
    ...row,
    y: ROUND_BASE_Y.value + index * ROUND_ROW_GAP.value,
  }))

  return { dots, edges, rows }
})

const roundMapDots = computed(() => roundMapGraph.value.dots)
const roundMapEdges = computed(() => roundMapGraph.value.edges)
const roundMapRows = computed(() => roundMapGraph.value.rows)
const roundMapSvgW = computed(() => Math.max(120 * treeUiScale.value, ...roundMapDots.value.map((dot) => dot.x)) + (24 * treeUiScale.value))
const roundMapSvgH = computed(() => Math.max(64 * treeUiScale.value, ...roundMapRows.value.map((row) => row.y)) + (16 * treeUiScale.value))
const roundMapHitRegions = computed(() => buildGraphHitRegions(
  roundMapDots.value,
  ROUND_ROW_GAP.value,
  roundMapDotRadius,
))

function treeDotRadius(dot: TreeDotLayout) {
  return (dot.isControlledAction ? 6 : 5) * treeUiScale.value
}

function treeSquareRadius(_dot: TreeDotLayout) {
  return 5 * treeUiScale.value
}

function treeDotHorizontalRadius(dot: TreeDotLayout) {
  return dot.shape === 'square' ? treeSquareRadius(dot) : treeDotRadius(dot)
}

const treeSquareCornerRadius = computed(() => 0.9 * treeUiScale.value)

function treeDotStrokeWidth(dot: TreeDotLayout) {
  const base = isCurrentTreeDot(dot) ? 1.5 : (dot.isMainline ? 0.8 : 0)
  return base * treeUiScale.value
}

function roundMapDotRadius(_dot: { isCurrent: boolean; isMainline: boolean }) {
  return 6 * treeUiScale.value
}

function roundMapDotStrokeWidth(dot: { isCurrent: boolean; isMainline: boolean }) {
  const base = dot.isCurrent ? 1.5 : (dot.isMainline ? 0.8 : 0)
  return base * treeUiScale.value
}

  watch(
    () => gameView.currentNodeId,
    async () => {
      onCurrentNodeChanged?.()
      await nextTick()
      updateTreeViewport()
      if (!treeAutoFollowSuspended) keepCurrentTreeDotVisible()
    },
  )

  watch(
    () => [treeSvgH.value, treeDots.value.length],
    async () => {
      await nextTick()
      updateTreeViewport()
    },
  )

  onMounted(() => {
    window.addEventListener('resize', updateTreeViewport)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('resize', updateTreeViewport)
    if (treeViewportRaf) {
      cancelAnimationFrame(treeViewportRaf)
      treeViewportRaf = 0
    }
  })

  return {
    ROUND_BASE_X,
    activeRoundRootId,
    isCurrentTreeDot,
    closeRoundMapOverlay,
    nodeMapById,
    openRoundMapOverlay,
    roundMapDotRadius,
    roundMapDotStrokeWidth,
    roundMapDots,
    roundMapEdges,
    roundMapHitRegions,
    roundMapHoveredRoundId,
    roundMapOverlayOpen,
    roundMapRows,
    roundMapSettlementLayout,
    roundMapSettlementRoundLabel,
    roundMapSettlementTitle,
    roundMapSvgH,
    roundMapSvgW,
    roundRootById,
    specialNextMoveClass,
    suspendTreeAutoFollow,
    resumeTreeAutoFollow,
    tileNextMoveClass,
    toggleRoundMapOverlay,
    treeBaseX,
    treeCanvasStyle,
    treeDotHorizontalRadius,
    treeDotRadius,
    treeDotStrokeWidth,
    treeDots,
    treeEdgeStroke,
    treeEdgeWidth,
    treeHoveredNodeId,
    treeNodeList,
    treeRowActionLabels,
    treeScrollEl,
    treeSquareCornerRadius,
    treeSquareRadius,
    treeSvgH,
    treeSvgW,
    updateTreeViewport,
    visibleTreeDots,
    visibleTreeEdges,
    visibleTreeHitRegions,
    visibleTreeRows,
    onTreeScroll,
  }
}
