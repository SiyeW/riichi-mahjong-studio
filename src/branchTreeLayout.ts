export interface BranchTreeStaticLayout {
  dots: Array<{ id: string; x: number; y: number; col: number }>
  edges: Array<{ from: string; to: string; d: string; minY: number; maxY: number }>
}

export interface BranchTreeGeometry {
  baseX: number
  baseY: number
  columnGap: number
  rowGap: number
}

interface SideBranchSeed {
  childId: string
  parentNodeId: string
  encounterIndex: number
  siblingOrder: number
}

interface BranchPlacement {
  id: string
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

interface HorizontalReservation {
  row: number
  colStart: number
  colEnd: number
}

export function branchTreeLayoutCacheKey(
  nodes: TrainerTreeNode[],
  roundRootId: string,
  geometry: BranchTreeGeometry,
): string {
  const structure = nodes
    .map((node) => `${node.id}|${node.parentId || ''}|${node.mainChildId || ''}|${(node.children || []).join(',')}|${node.roundDepth ?? node.depth}`)
    .join(';')
  return [
    roundRootId,
    geometry.baseX,
    geometry.baseY,
    geometry.columnGap,
    geometry.rowGap,
    structure,
  ].join('::')
}

export function computeBranchTreeLayout(
  nodes: TrainerTreeNode[],
  roundRootId: string,
  geometry: BranchTreeGeometry,
): BranchTreeStaticLayout {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]))
  const rootNode = nodeMap.get(roundRootId)
  if (!rootNode) return { dots: [], edges: [] }

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

  function createBranch(
    startNodeId: string,
    parentBranchId: string,
    parentNodeId: string,
    encounterIndex: number,
    siblingOrder: number,
  ) {
    const startNode = nodeMap.get(startNodeId)
    if (!startNode) return

    const branchId = `branch-${branchCounter++}`
    const branchNodes = collectBranchNodes(startNodeId, branchId)
    const endDepth = nodeMap.get(branchNodes[branchNodes.length - 1])?.roundDepth
      ?? startNode.roundDepth
      ?? startNode.depth
    const parentNode = nodeMap.get(parentNodeId)
    const parentRow = parentNode
      ? (parentNode.roundDepth ?? parentNode.depth)
      : (startNode.roundDepth ?? startNode.depth)
    const startRow = startNode.roundDepth ?? startNode.depth

    const branch: BranchPlacement = {
      id: branchId,
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
      node.children.forEach((childId, index) => {
        if (childId === node.mainChildId) return
        sideSeeds.push({
          childId,
          parentNodeId: node.id,
          encounterIndex: encounterCounter++,
          siblingOrder: index,
        })
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
    node.children.forEach((childId, index) => {
      if (childId !== node.mainChildId) {
        createBranch(childId, mainBranchId, node.id, encounterCounter++, index)
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
  const horizontalReservations: HorizontalReservation[] = []
  const assignedBranches: BranchPlacement[] = [mainBranch]

  function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
    return aStart <= bEnd && bStart <= aEnd
  }

  function isColumnLegal(branch: BranchPlacement, col: number) {
    for (const placed of assignedBranches) {
      if (placed.id === branch.id || placed.col !== col) continue
      if (intervalsOverlap(branch.reserveStart, branch.endRow, placed.reserveStart, placed.endRow)) return false
    }
    for (const horizontal of horizontalReservations) {
      if (
        horizontal.colStart <= col
        && col <= horizontal.colEnd
        && branch.reserveStart <= horizontal.row
        && horizontal.row <= branch.endRow
      ) return false
    }
    return true
  }

  function isHorizontalLegal(branch: BranchPlacement, col: number) {
    for (const placed of assignedBranches) {
      if (placed.id === branch.id || placed.col <= branch.parentCol || placed.col > col) continue
      if (placed.actualStart <= branch.parentRow && branch.parentRow <= placed.endRow) return false
    }
    return true
  }

  function previousSiblingCol(branch: BranchPlacement) {
    let maxCol = branch.parentCol
    for (const placed of assignedBranches) {
      if (
        placed.parentNodeId === branch.parentNodeId
        && placed.siblingOrder < branch.siblingOrder
        && placed.col > maxCol
      ) maxCol = placed.col
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

  const dots = [...nodes]
    .sort((a, b) => (
      (a.roundDepth ?? a.depth) - (b.roundDepth ?? b.depth)
      || ((branchById.get(nodeBranchId.get(a.id) || '')?.col ?? 0)
        - (branchById.get(nodeBranchId.get(b.id) || '')?.col ?? 0))
      || a.id.localeCompare(b.id)
    ))
    .map((node) => {
      const col = branchById.get(nodeBranchId.get(node.id) || '')?.col ?? 0
      return {
        id: node.id,
        x: geometry.baseX + col * geometry.columnGap,
        y: geometry.baseY + (((node.roundDepth ?? node.depth) - 1) * geometry.rowGap),
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
    .filter((edge): edge is NonNullable<typeof edge> => edge !== null)

  return { dots, edges }
}
