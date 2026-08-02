interface TableHistoryNode {
  id: string
  action: Record<string, unknown> | null
}

interface MeldNodeEntry {
  baseNodeId: string
  kakanNodeId: string | null
  type: string
  tileFamily: string
}

export interface TableActionNodeIndex {
  discardNodeIdsBySeat: string[][]
  meldNodeIdsBySeat: Array<Array<{ baseNodeId: string; kakanNodeId: string | null }>>
}

const PLAYER_COUNT = 4
const MELD_CREATION_TYPES = new Set(['chi', 'pon', 'daiminkan', 'ankan'])

function actionActor(action: Record<string, unknown>): number {
  const actor = Number(action.actor)
  return Number.isInteger(actor) && actor >= 0 && actor < PLAYER_COUNT ? actor : -1
}

function normalizeTileFamily(tile: unknown): string {
  return String(tile || '')
    .replaceAll('r', '')
    .replace(/^0([mps])$/, '5$1')
}

export function buildTableActionNodeIndex(nodes: TableHistoryNode[]): TableActionNodeIndex {
  const discardNodeIdsBySeat = Array.from({ length: PLAYER_COUNT }, () => [] as string[])
  const meldEntriesBySeat = Array.from({ length: PLAYER_COUNT }, () => [] as MeldNodeEntry[])

  for (const node of nodes) {
    const action = node.action
    if (!action) continue
    const actor = actionActor(action)
    if (actor < 0) continue
    const type = String(action.type || '')

    if (type === 'dahai') {
      discardNodeIdsBySeat[actor].push(node.id)
      continue
    }

    const consumed = Array.isArray(action.consumed) ? action.consumed : []
    const tileFamily = normalizeTileFamily(action.pai || consumed[0])
    if (MELD_CREATION_TYPES.has(type)) {
      meldEntriesBySeat[actor].push({ baseNodeId: node.id, kakanNodeId: null, type, tileFamily })
      continue
    }

    if (type === 'kakan') {
      const entries = meldEntriesBySeat[actor]
      const ponIndex = entries.findLastIndex((entry) => (
        entry.type === 'pon' && entry.tileFamily === tileFamily
      ))
      if (ponIndex >= 0) {
        entries[ponIndex].kakanNodeId = node.id
      } else {
        entries.push({ baseNodeId: node.id, kakanNodeId: node.id, type, tileFamily })
      }
    }
  }

  return {
    discardNodeIdsBySeat,
    meldNodeIdsBySeat: meldEntriesBySeat.map((entries) => entries.map((entry) => ({
      baseNodeId: entry.baseNodeId,
      kakanNodeId: entry.kakanNodeId,
    }))),
  }
}
