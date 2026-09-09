import {
  computed,
  ref,
  type Ref,
} from 'vue'
import { buildGraphHitRegions } from './graphHitRegions'
import {
  branchTreeLayoutCacheKey,
  computeBranchTreeLayout,
  type BranchTreeStaticLayout,
} from './branchTreeLayout'
import { useNextMoveHints } from './useNextMoveHints'
import type { StudioSettings } from './contracts/settings'
import { useRoundMapPresentation } from './useRoundMapPresentation'
import { useVirtualizedTreeViewport } from './useVirtualizedTreeViewport'

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

export interface TreeRowLayout {
  depth: number
  nodeId: string
  y: number
  label: string
  isControlledAction: boolean
}

export function useBranchTreePresentation(options: {
  gameView: TrainerGameView
  status: TrainerStatusSnapshot
  settings: StudioSettings
  uiScale: Readonly<Ref<number>>
  showTreeComparisons: Readonly<Ref<boolean>>
  t: Translate
  formatTreeAction: (action?: Record<string, unknown> | null) => string
  localizedResultTitle: (value: unknown) => string
  relativeSeatLabel: (seat: number) => string
  roundWindLabel: (wind: string) => string
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
    focusRoundMap,
  } = options

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
const treeBaseX = computed(() => TREE_BASE_X.value)

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

const treeLayoutStaticCache = new Map<string, BranchTreeStaticLayout>()

const treeGraph = computed(() => {
  const nodes = roundTreeNodeList.value
  const roundRootId = activeRoundRootId.value
  if (!nodes.length || !roundRootId) {
    return { dots: [] as TreeDotLayout[], edges: [] as TreeEdgeLayout[] }
  }
  const geometry = {
    baseX: TREE_BASE_X.value,
    baseY: TREE_BASE_Y.value,
    columnGap: TREE_COL_GAP.value,
    rowGap: TREE_ROW_GAP.value,
  }
  const cacheKey = branchTreeLayoutCacheKey(nodes, roundRootId, geometry)
  let layout = treeLayoutStaticCache.get(cacheKey)
  if (!layout) {
    layout = computeBranchTreeLayout(nodes, roundRootId, geometry)
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

const {
  onTreeScroll,
  resumeTreeAutoFollow,
  suspendTreeAutoFollow,
  treeScrollEl,
  updateTreeViewport,
  visibleTreeDots,
  visibleTreeEdges,
  visibleTreeHitRegions,
  visibleTreeRows,
} = useVirtualizedTreeViewport({
  dots: treeDots,
  edges: treeEdges,
  hitRegions: treeHitRegions,
  rows: treeRows,
  contentHeight: treeSvgH,
  currentNodeId: () => gameView.currentNodeId || null,
  currentDot: () => (
    gameView.currentNodeId
      ? treeDotById.value.get(gameView.currentNodeId) || null
      : null
  ),
  clearHover: () => {
    treeHoveredNodeId.value = null
  },
})

const {
  ROUND_BASE_X,
  closeRoundMapOverlay,
  openRoundMapOverlay,
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
  toggleRoundMapOverlay,
} = useRoundMapPresentation({
  roundSummaryList,
  activeRoundRootId,
  status,
  uiScale,
  t,
  localizedResultTitle,
  relativeSeatLabel,
  roundWindLabel,
  focusRoundMap,
})

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

  return {
    ROUND_BASE_X,
    activeRoundRootId,
    isCurrentTreeDot,
    closeRoundMapOverlay,
    nodeMapById,
    openRoundMapOverlay,
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
