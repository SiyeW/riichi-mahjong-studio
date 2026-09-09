import { computed, type Ref } from 'vue'
import type { GameAction } from './contracts/game'

export interface NextMoveHint {
  type: 'dahai' | 'special'
  childNodeId: string
  isMainBranch: boolean
  pai?: string
  tsumogiri?: boolean
  actionType?: string
  actionVariant?: string
  consumed?: string[]
}

function normalizeSpecialActionVariant(
  actionType?: string,
  actionVariant?: string,
): string | undefined {
  if (actionVariant) return actionVariant
  return actionType === 'reach' ? 'declare' : undefined
}

export function buildNextMoveHints(
  nodeMap: ReadonlyMap<string, TrainerTreeNode>,
  currentNodeId: string | null,
  controlledSeat: number,
): NextMoveHint[] {
  if (!currentNodeId) return []
  const node = nodeMap.get(currentNodeId)
  if (!node) return []
  const children = node.children || []
  if (!children.length) return []
  const mainChildId = node.mainChildId

  const hints: NextMoveHint[] = []
  for (const childId of children) {
    const child = nodeMap.get(childId)
    if (!child || !child.action) continue
    const action = child.action as Record<string, unknown>
    if (Number(action.actor) !== controlledSeat || typeof action.type !== 'string') {
      continue
    }
    const isMainBranch = childId === mainChildId

    if (action.type === 'dahai' && typeof action.pai === 'string') {
      hints.push({
        type: 'dahai',
        childNodeId: childId,
        isMainBranch,
        pai: action.pai,
        tsumogiri: Boolean(action.tsumogiri),
      })
      continue
    }
    hints.push({
      type: 'special',
      childNodeId: childId,
      isMainBranch,
      actionType: action.type,
      actionVariant: normalizeSpecialActionVariant(
        action.type,
        typeof action.variant === 'string' ? action.variant : undefined,
      ),
      consumed: Array.isArray(action.consumed) ? action.consumed.map(String) : [],
    })
  }
  return hints
}

export function useNextMoveHints(options: {
  nodeMapById: Readonly<Ref<Map<string, TrainerTreeNode>>>
  currentNodeId: () => string | null
  controlledSeat: () => number
}) {
  const nextMoveHints = computed(() => buildNextMoveHints(
    options.nodeMapById.value,
    options.currentNodeId(),
    options.controlledSeat(),
  ))

  function getTileNextMoveHint(
    tile: string,
    fromDrawn: boolean,
  ): NextMoveHint | null {
    return nextMoveHints.value.find((hint) => (
      hint.type === 'dahai'
      && hint.pai === tile
      && Boolean(hint.tsumogiri) === fromDrawn
    )) || null
  }

  function getSpecialNextMoveHint(action: GameAction): NextMoveHint | null {
    const consumed = [...(action.consumed || [])].sort().join(',')
    return nextMoveHints.value.find((hint) => (
      hint.type === 'special'
      && hint.actionType === action.type
      && hint.actionVariant === normalizeSpecialActionVariant(
        action.type,
        action.variant,
      )
      && [...(hint.consumed || [])].sort().join(',') === consumed
    )) || null
  }

  function tileNextMoveClass(tile: string, fromDrawn: boolean): string {
    const hint = getTileNextMoveHint(tile, fromDrawn)
    if (!hint) return ''
    return hint.isMainBranch ? 'tile-next-main' : 'tile-next-side'
  }

  function specialNextMoveClass(action: GameAction): string {
    const hint = getSpecialNextMoveHint(action)
    if (!hint) return ''
    return hint.isMainBranch ? 'special-next-main' : 'special-next-side'
  }

  return {
    specialNextMoveClass,
    tileNextMoveClass,
  }
}
