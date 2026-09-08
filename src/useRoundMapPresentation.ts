import { computed, ref, type Ref } from 'vue'
import { buildGraphHitRegions } from './graphHitRegions.ts'

type Translate = (key: string, params?: Record<string, string | number>) => string

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

export interface RoundMapRowLayout {
  key: string
  label: string
  roundIndex: number
  honba: number
  y: number
}

export interface RoundMapSettlementEntry {
  position: 'toimen' | 'kamicha' | 'shimocha' | 'self'
  seat: number
  label: string
  hasScores: boolean
  showDelta: boolean
  rank: number | null
  before: number
  delta: number
  after: number
}

export function useRoundMapPresentation(options: {
  roundSummaryList: Readonly<Ref<TrainerRoundSummary[]>>
  activeRoundRootId: Readonly<Ref<string | null>>
  status: TrainerStatusSnapshot
  uiScale: Readonly<Ref<number>>
  t: Translate
  localizedResultTitle: (value: unknown) => string
  relativeSeatLabel: (seat: number) => string
  roundWindLabel: (wind: string) => string
  focusRoundMap: () => void
}) {
  const {
    roundSummaryList,
    activeRoundRootId,
    status,
    uiScale,
    t,
    localizedResultTitle,
    relativeSeatLabel,
    roundWindLabel,
    focusRoundMap,
  } = options
  const treeUiScale = computed(() => uiScale.value)
  const ROUND_COL_GAP = computed(() => 18 * treeUiScale.value)
  const ROUND_ROW_GAP = computed(() => 18 * treeUiScale.value)
  const ROUND_BASE_X = computed(() => 18 * treeUiScale.value)
  const ROUND_BASE_Y = computed(() => 12 * treeUiScale.value)

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

  const roundRootNodeList = computed(() =>
    roundSummaryList.value
      .slice()
      .sort(
        (a, b) =>
          (a.roundIndex ?? 0) - (b.roundIndex ?? 0) ||
          (a.honba ?? 0) - (b.honba ?? 0) ||
          a.depth - b.depth ||
          a.id.localeCompare(b.id),
      ),
  )

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
    const uniqueSlots = new Map<
      string,
      { key: string; label: string; roundIndex: number; honba: number }
    >()
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
    const ordered = Array.from(uniqueSlots.values()).sort(
      (a, b) => a.roundIndex - b.roundIndex || a.honba - b.honba || a.key.localeCompare(b.key),
    )
    const rowByKey = new Map<string, number>()
    ordered.forEach((slot, index) => rowByKey.set(slot.key, index))
    return { ordered, rowByKey }
  })

  const roundRootById = computed(
    () => new Map(roundRootNodeList.value.map((node) => [node.id, node])),
  )

  const roundMapHoveredRound = computed(() =>
    roundMapHoveredRoundId.value
      ? roundRootById.value.get(roundMapHoveredRoundId.value) || null
      : null,
  )

  const roundMapCurrentBranchTail = computed(() => {
    let currentId =
      activeRoundRootId.value ||
      roundRootNodeList.value.find((round) => round.isCurrent)?.id ||
      roundRootNodeList.value[0]?.id ||
      null
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

  const roundMapSettlementRound = computed(
    () => roundMapHoveredRound.value || roundMapCurrentBranchTail.value,
  )

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
    return (
      localizedResultTitle(round.resultInfo?.title) ||
      (isTerminal ? t('action.matchEnd') : t('result.inProgress'))
    )
  })

  const roundMapSettlementLayout = computed<RoundMapSettlementEntry[]>(() => {
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

    const rootRoundId =
      roundRootNodeList.value.find((node) => !parentRoundId.has(node.id))?.id ||
      roundRootNodeList.value[0]?.id ||
      null
    return { childRoundIds, parentRoundId, mainNextRoundId, rootRoundId }
  })

  const roundMapGraph = computed(() => {
    if (!roundMapOverlayOpen.value) {
      return {
        dots: [] as RoundMapDotLayout[],
        edges: [] as RoundMapEdgeLayout[],
        rows: [] as RoundMapRowLayout[],
      }
    }
    const roundNodes = roundRootNodeList.value
    const { rowByKey, ordered } = roundMapRowMeta.value
    const { childRoundIds, parentRoundId, mainNextRoundId, rootRoundId } = roundGraphMeta.value
    if (!roundNodes.length || !rootRoundId) {
      return {
        dots: [] as RoundMapDotLayout[],
        edges: [] as RoundMapEdgeLayout[],
        rows: [] as RoundMapRowLayout[],
      }
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

    function createBranch(
      startRoundId: string,
      parentBranchId: string,
      parentRoundId: string,
      encounterIndex: number,
      siblingOrder: number,
    ) {
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
          if (childId !== mainChild)
            createBranch(childId, branchId, roundId, encounterCounter++, idx)
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
        if (childId !== mainChild)
          createBranch(childId, mainBranchId, roundId, encounterCounter++, idx)
      })
    })

    const nonMainBranches = branches
      .filter((branch) => branch.id !== mainBranchId)
      .sort(
        (a, b) =>
          a.encounterIndex - b.encounterIndex ||
          a.startRow - b.startRow ||
          a.siblingOrder - b.siblingOrder,
      )

    interface HorizontalReservation {
      row: number
      colStart: number
      colEnd: number
    }
    const horizontalReservations: HorizontalReservation[] = []
    const assignedBranches: RoundBranch[] = [mainBranch]

    function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
      return aStart <= bEnd && bStart <= aEnd
    }

    function isColumnLegal(branch: RoundBranch, col: number) {
      for (const placed of assignedBranches) {
        if (placed.id === branch.id || placed.col !== col) continue
        if (
          intervalsOverlap(branch.reserveStart, branch.endRow, placed.reserveStart, placed.endRow)
        )
          return false
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
      const parentBranch = branch.parentBranchId
        ? branchById.get(branch.parentBranchId)
        : mainBranch
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
            d:
              parent.col === child.col
                ? `M ${parent.x} ${parent.y} L ${child.x} ${child.y}`
                : `M ${parent.x} ${parent.y} L ${child.x} ${parent.y} L ${child.x} ${child.y}`,
            stroke: isCurrentPath
              ? 'rgba(232,246,243,0.88)'
              : isMainline
                ? 'rgba(159,213,200,0.56)'
                : 'rgba(159,213,200,0.22)',
            width: (isCurrentPath ? 2.2 : isMainline ? 1.5 : 1.2) * treeUiScale.value,
          }
        })
      })
      .flat()
      .filter(Boolean) as RoundMapEdgeLayout[]

    const rows: RoundMapRowLayout[] = ordered.map((row, index) => ({
      ...row,
      y: ROUND_BASE_Y.value + index * ROUND_ROW_GAP.value,
    }))

    return { dots, edges, rows }
  })

  const roundMapDots = computed(() => roundMapGraph.value.dots)
  const roundMapEdges = computed(() => roundMapGraph.value.edges)
  const roundMapRows = computed(() => roundMapGraph.value.rows)
  const roundMapSvgW = computed(
    () =>
      Math.max(120 * treeUiScale.value, ...roundMapDots.value.map((dot) => dot.x)) +
      24 * treeUiScale.value,
  )
  const roundMapSvgH = computed(
    () =>
      Math.max(64 * treeUiScale.value, ...roundMapRows.value.map((row) => row.y)) +
      16 * treeUiScale.value,
  )
  const roundMapHitRegions = computed(() =>
    buildGraphHitRegions(roundMapDots.value, ROUND_ROW_GAP.value, () => 6 * treeUiScale.value),
  )

  return {
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
  }
}
