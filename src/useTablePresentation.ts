import { computed, type Ref } from 'vue'
import {
  adaptiveProbabilityScale,
  clampProbability,
  DEFAULT_PROBABILITY_SCALE,
} from './analysisProbabilityScale'
import { RON_WAIT_OPPONENT_KEYS, tile34Index } from './analysisTiles'
import { buildTableActionNodeIndex } from './tableHistoryNavigation'
import type { MahjongPresentationLabels } from './useMahjongPresentationLabels'

type Translate = (key: string, params?: Record<string, string | number>) => string
type DiscardEntry = NonNullable<TrainerGameView['analysis']>['discardEntries'][number]

export interface DiscardBarSlot {
  tile: string
  entry: DiscardEntry | null
  isBest: boolean
  isDrawn: boolean
  isGap: boolean
}
export interface HandParts {
  closed: string[]
  drawn: string | null
}

export interface MeldDisplayTile {
  tile: string
  isBack: boolean
  tileClass: string
  isKakan?: boolean
}

export interface RiverDisplaySlot {
  key: string
  tile: string
  sourceNodeId: string | null
  isPending: boolean
  isTsumogiri: boolean
  isClaimed: boolean
  isRiichiDiscard: boolean
}

export interface TableSeatView {
  seat: number
  position: 'north' | 'west' | 'east' | 'south'
  hand: string[]
  river: string[]
  melds: Array<Record<string, unknown>>
  riichiDeclared: boolean
  riichiAccepted: boolean
}

export function useTablePresentation(options: {
  gameView: TrainerGameView
  status: TrainerStatusSnapshot
  currentTrainingMode: Readonly<Ref<TrainerSettings['training']['mode']>>
  ronWaitPredData: Readonly<Ref<Record<string, number[]>>>
  t: Translate
  labels: MahjongPresentationLabels
  resolveDiscardEntry: (action: TrainerAction) => DiscardEntry | null
  analysisEntryIsBest: (entry: DiscardEntry | null) => boolean
  getNodeMapById: () => ReadonlyMap<string, TrainerTreeNode>
  jumpToNode: (nodeId: string) => Promise<void>
}) {
  const {
    gameView,
    status,
    currentTrainingMode,
    ronWaitPredData,
    t,
    labels,
    resolveDiscardEntry,
    analysisEntryIsBest,
    getNodeMapById,
    jumpToNode,
  } = options

  const {
    relativeSeatLabel,
    seatWindLabel,
    isCurrentActorSeat,
    roundWindLabel,
    tileFaceLabel,
    reactionTypeLabel,
    ryukyokuActionLabel,
    specialActionLabel,
    normalizeTileFamily,
    redFive,
  } = labels


  const tableSeatViews = computed<TableSeatView[]>(() => {
    const hands = gameView.table?.hands || []
    const rivers = gameView.table?.rivers || []
    const melds = gameView.table?.melds || []
    const pendingKan = gameView.table?.pendingKan || null
    const controlled = status.controlledSeat
    const order: Array<Pick<TableSeatView, 'seat' | 'position'>> = [
      { seat: (controlled + 2) % 4, position: 'north' },
      { seat: (controlled + 3) % 4, position: 'west' },
      { seat: (controlled + 1) % 4, position: 'east' },
      { seat: controlled, position: 'south' },
    ]

    const displayMeldsForSeat = (seat: number, seatMelds: Array<Record<string, unknown>>) => {
      if (!pendingKan || pendingKan.source !== 'kakan' || Number(pendingKan.actor) !== seat) {
        return seatMelds
      }
      const targetPai = String(pendingKan.pai || '')
      let upgraded = false
      return seatMelds.map((meld) => {
        if (!upgraded && meld?.type === 'pon' && String(meld.pai || '') === targetPai) {
          upgraded = true
          return {
            ...meld,
            type: 'kakan',
            pai: targetPai,
          }
        }
        return meld
      })
    }

    return order.map((entry) => ({
      ...entry,
      hand: hands[entry.seat] || [],
      river: rivers[entry.seat] || [],
      melds: displayMeldsForSeat(entry.seat, (melds[entry.seat] || []) as Array<Record<string, unknown>>),
      riichiDeclared: gameView.table?.riichiDeclared?.[entry.seat] || false,
      riichiAccepted: gameView.table?.riichiAccepted?.[entry.seat] || false,
    }))
  })

  const southView = computed(() => tableSeatViews.value.find((sv) => sv.position === 'south'))
  const northView = computed(() => tableSeatViews.value.find((sv) => sv.position === 'north'))
  const eastView = computed(() => tableSeatViews.value.find((sv) => sv.position === 'east'))
  const westView = computed(() => tableSeatViews.value.find((sv) => sv.position === 'west'))
  const HAND_DISCARD_GAP = '__hand_discard_gap__'
  const HAND_SUIT_ORDER: Record<string, number> = { m: 0, p: 1, s: 2 }
  const HAND_HONOR_ORDER: Record<string, number> = { E: 30, S: 31, W: 32, N: 33, P: 34, F: 35, C: 36 }

  const discardActions = computed(() => (
    gameView.legalActions.filter((action) => action.type === 'dahai')
  ))

  const SPECIAL_ACTION_ORDER: Record<string, number> = {
    hora: 0,
    reach: 1,
    chi: 2,
    pon: 3,
    daiminkan: 4,
    ankan: 4,
    kakan: 4,
    ryukyoku: 5,
    none: Number.MAX_SAFE_INTEGER,
  }

  function chiSequenceStart(action: TrainerAction): number {
    const numbers = [action.pai, ...(action.consumed || [])]
      .filter((tile): tile is string => Boolean(tile))
      .map((tile) => Number(normalizeTileFamily(tile)[0]))
      .filter(Number.isFinite)
    return numbers.length ? Math.min(...numbers) : Number.MAX_SAFE_INTEGER
  }

  function compareSpecialActions(left: TrainerAction, right: TrainerAction): number {
    const typeOrder = (SPECIAL_ACTION_ORDER[left.type] ?? 6) - (SPECIAL_ACTION_ORDER[right.type] ?? 6)
    if (typeOrder !== 0) return typeOrder
    if (left.type === 'chi' && right.type === 'chi') {
      return chiSequenceStart(left) - chiSequenceStart(right)
    }
    return 0
  }

  const specialActions = computed(() => (
    gameView.legalActions.filter((action) => (
      action.type !== 'dahai'
      && !(action.type === 'reach' && gameView.table?.pendingRiichiSeat === status.controlledSeat)
    )).sort(compareSpecialActions)
  ))

  const showTreeComparisons = computed(() => (
    status.mode === 'research' || currentTrainingMode.value !== 'no_review'
  ))

  const centerDoraSlots = computed(() => {
    const indicators = gameView.table?.doraIndicators || []
    return Array.from({ length: 5 }, (_, index) => indicators[index] || '?')
  })

  const pendingDiscardEntry = computed(() => {
    const riichiDiscard = gameView.table?.pendingRiichiDiscard
    const pendingDiscard = gameView.table?.pendingDiscard
    return riichiDiscard || pendingDiscard || null
  })

  const pendingDiscardBySeat = computed<Record<number, { pai: string; tsumogiri: boolean; riichi: boolean } | null>>(() => {
    const result: Record<number, { pai: string; tsumogiri: boolean; riichi: boolean } | null> = { 0: null, 1: null, 2: null, 3: null }
    const pending = pendingDiscardEntry.value
    if (pending) {
      result[pending.actor] = { pai: pending.pai, tsumogiri: Boolean(pending.tsumogiri), riichi: Boolean(pending.riichi) }
    }
    return result
  })

  const southDiscardBarSlots = computed<DiscardBarSlot[]>(() => {
    const displayParts = southDisplayHandParts.value
    const visualSlots = [
      ...displayParts.closed.map((tile) => ({ tile, isDrawn: false })),
      ...(displayParts.drawn ? [{ tile: displayParts.drawn, isDrawn: true }] : []),
    ]
    const hand = visualSlots
      .filter(({ tile }) => tile !== HAND_DISCARD_GAP)
      .map(({ tile }) => tile)
    const handFamilyGroups = new Map<string, string[]>()
    hand.forEach((tile) => {
      const family = normalizeTileFamily(tile)
      const tiles = handFamilyGroups.get(family) || []
      tiles.push(tile)
      handFamilyGroups.set(family, tiles)
    })

    return visualSlots.map(({ tile, isDrawn }) => {
      const isGap = tile === HAND_DISCARD_GAP
      if (isGap) {
        return { tile, entry: null, isBest: false, isDrawn, isGap }
      }
      const familyTiles = handFamilyGroups.get(normalizeTileFamily(tile)) || [tile]
      const exactAction = discardActions.value.find((action) => (
        action.pai === tile && Boolean(action.tsumogiri) === isDrawn
      ))
      const familyAction = new Set(familyTiles).size === 1
        ? discardActions.value.find((action) => (
          normalizeTileFamily(action.pai || '') === normalizeTileFamily(tile)
          && Boolean(action.tsumogiri) === isDrawn
        ))
        : null
      const action = exactAction || familyAction || null
      const entry = action ? resolveDiscardEntry(action) : null
      const isBest = analysisEntryIsBest(entry)
      return { tile, entry, isBest, isDrawn, isGap }
    })
  })

  const southLaneStyle = computed(() => {
    const displayParts = southDisplayHandParts.value
    const count = displayParts.closed.length + (displayParts.drawn ? 1 : 0) || 13
    const drawnGap = displayParts.drawn ? 'calc(0.4 * var(--tile-w))' : '0px'
    return {
      '--south-hand-span': `calc(${count} * var(--tile-w) + ${drawnGap})`,
      '--south-base-span': `calc(${Math.max(count, 13)} * var(--tile-w) + ${drawnGap})`,
    }
  })

  const currentTableHistoryNodes = computed(() => {
    const nodes: TrainerTreeNode[] = []
    let cursor = gameView.currentNodeId || ''
    while (cursor) {
      const node = getNodeMapById().get(cursor)
      if (!node) break
      nodes.push(node)
      cursor = node.parentId || ''
    }
    return nodes.reverse()
  })

  const tableActionNodeIndex = computed(() => buildTableActionNodeIndex(currentTableHistoryNodes.value))

  function canJumpToHistoricalNode(nodeId: string | null | undefined): boolean {
    return status.mode === 'research' && Boolean(nodeId) && nodeId !== gameView.currentNodeId
  }

  function historicalJumpTitle(nodeId: string | null | undefined, _source: string): string | undefined {
    return canJumpToHistoricalNode(nodeId) ? t('action.doubleClickJump') : undefined
  }

  function jumpToHistoricalNode(nodeId: string | null | undefined) {
    if (!canJumpToHistoricalNode(nodeId) || !nodeId) return
    void jumpToNode(nodeId)
  }

  function meldNodeId(seat: number, meldIndex: number, layer: 'base' | 'kakan' = 'base'): string | null {
    const source = tableActionNodeIndex.value.meldNodeIdsBySeat[seat]?.[meldIndex]
    if (!source) return null
    return layer === 'kakan' ? source.kakanNodeId : source.baseNodeId
  }

  function meldDisplayTiles(meld: Record<string, unknown>, actor: number): MeldDisplayTile[] {
    const consumed: string[] = Array.isArray(meld.consumed) ? meld.consumed.map((tile) => String(tile)) : []
    const pai = typeof meld.pai === 'string' ? meld.pai : ''
    const type = typeof meld.type === 'string' ? meld.type : ''
    const fromSeat: number | undefined = meld.from !== undefined ? Number(meld.from) : undefined

    if (type === 'ankan') {
      return consumed.map((tile, i) => {
        const isOuter = i === 0 || i === 3
        let displayTile = tile
        if (!isOuter && (tile === '5m' || tile === '5p' || tile === '5s')) {
          displayTile = redFive(tile)
        }
        return { tile: displayTile, isBack: isOuter, tileClass: '' }
      })
    }
    if (type === 'kakan') {
      const fromPon = fromSeat !== undefined ? (fromSeat - actor + 4) % 4 : -1
      let rotateIndex: number
      if (fromPon === 3) {
        rotateIndex = 0
      } else if (fromPon === 2) {
        rotateIndex = 1
      } else {
        rotateIndex = 2
      }
      return [pai, pai, pai].map((tile, i) => ({
        tile,
        isBack: false,
        tileClass: i === rotateIndex ? 'rotate' : '',
        isKakan: i === rotateIndex,
      }))
    }
    if (type === 'daiminkan') {
      const fromKan = fromSeat !== undefined ? (fromSeat - actor + 4) % 4 : -1
      let ordered: string[]
      let rotateIndex = 1
      if (fromKan === 3) {
        ordered = [pai, ...consumed]
        rotateIndex = 0
      } else if (fromKan === 2) {
        ordered = [consumed[0], pai, consumed[1], consumed[2]]
        rotateIndex = 1
      } else {
        ordered = [...consumed, pai]
        rotateIndex = 3
      }
      return ordered.map((tile, i) => ({
        tile,
        isBack: false,
        tileClass: i === rotateIndex ? 'rotate' : '',
      }))
    }
    if (type === 'chi' && fromSeat !== undefined) {
      const diff = (fromSeat - actor + 4) % 4
      let ordered: string[]
      let rotateIndex: number
      if (diff === 3) {
        ordered = [pai, consumed[0], consumed[1]]
        rotateIndex = 0
      } else if (diff === 2) {
        ordered = [consumed[0], pai, consumed[1]]
        rotateIndex = 1
      } else {
        ordered = [consumed[0], consumed[1], pai]
        rotateIndex = 2
      }
      return ordered.map((tile, i) => ({ tile, isBack: false, tileClass: i === rotateIndex ? 'rotate' : '' }))
    }
    if (type === 'pon') {
      const fromPon = fromSeat !== undefined ? (fromSeat - actor + 4) % 4 : -1
      let ordered: string[]
      let rotateIndex: number
      if (fromPon === 3) {
        ordered = [pai, consumed[0], consumed[1]]
        rotateIndex = 0
      } else if (fromPon === 2) {
        ordered = [consumed[0], pai, consumed[1]]
        rotateIndex = 1
      } else {
        ordered = [consumed[0], consumed[1], pai]
        rotateIndex = 2
      }
      return ordered.filter(Boolean).map((tile, i) => ({
        tile,
        isBack: false,
        tileClass: i === rotateIndex ? 'rotate' : '',
      }))
    }
    const tiles = [...consumed, pai].filter(Boolean)
    return tiles.map((tile, i) => ({ tile, isBack: false, tileClass: i === tiles.length - 1 ? 'rotate' : '' }))
  }

  function splitHandForView(view: { seat: number; hand: string[] } | undefined | null): HandParts {
    const hand = view?.hand || []
    if (!view) return { closed: [], drawn: null }
    const lastDraw = gameView.table?.lastDrawnSeat === view.seat ? (gameView.table?.lastDrawnTile || null) : null
    const history = gameView.table?.actionHistory || []
    const justDrew = (() => {
      for (let i = history.length - 1; i >= 0; i--) {
        const a = history[i] as Record<string, unknown>
        if (Number(a.actor) !== view.seat) continue
        const t = String(a.type || '')
        if (t === 'tsumo') return true
        if (t === 'dahai') return false
        // reach / pon / chi / kan / hora etc. don't change draw-vs-discard state
      }
      return false
    })()
    if (!justDrew) return { closed: [...hand], drawn: null }
    if (lastDraw) {
      let drawnIdx = hand.lastIndexOf(lastDraw)
      if (drawnIdx === -1 && hand.length % 3 === 2) drawnIdx = hand.length - 1
      if (drawnIdx === -1) return { closed: [...hand], drawn: null }
      const closed = [...hand]
      const [drawn] = closed.splice(drawnIdx, 1)
      return { closed, drawn: drawn || null }
    }
    if (hand.length % 3 === 2) return { closed: hand.slice(0, -1), drawn: hand[hand.length - 1] || null }
    return { closed: [...hand], drawn: null }
  }

  function compareHandTiles(left: string, right: string): number {
    if (left in HAND_HONOR_ORDER || right in HAND_HONOR_ORDER) {
      if (!(left in HAND_HONOR_ORDER)) return -1
      if (!(right in HAND_HONOR_ORDER)) return 1
      return HAND_HONOR_ORDER[left] - HAND_HONOR_ORDER[right]
    }
    const leftBase = left.replace('r', '')
    const rightBase = right.replace('r', '')
    const suitDelta = (HAND_SUIT_ORDER[leftBase[1]] ?? 9) - (HAND_SUIT_ORDER[rightBase[1]] ?? 9)
    if (suitDelta) return suitDelta
    const rankDelta = Number(leftBase[0]) - Number(rightBase[0])
    if (rankDelta) return rankDelta
    if (left.endsWith('r') !== right.endsWith('r')) return left.endsWith('r') ? 1 : -1
    return left.localeCompare(right)
  }

  function lastDrawBeforePendingDiscard(seat: number): string | null {
    const history = gameView.table?.actionHistory || []
    let skippedPendingDiscard = false
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const action = history[index]
      if (Number(action.actor ?? -1) !== seat) continue
      const type = String(action.type || '')
      if (type === 'dahai' && !skippedPendingDiscard) {
        skippedPendingDiscard = true
        continue
      }
      if (type === 'reach') continue
      if (type === 'tsumo') return String(action.pai || '') || null
      return null
    }
    return null
  }

  function deterministicGapIndex(seat: number, tile: string, slotCount: number): number {
    if (slotCount <= 1) return 0
    const table = gameView.table
    // State-derived randomness stays stable when the same node is rendered again.
    const seed = [
      gameView.gameId,
      table?.roundIndex,
      table?.honba,
      table?.drawIndex,
      table?.rivers?.[seat]?.length,
      seat,
      tile,
    ].join('|')
    let hash = 2166136261
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0) % slotCount
  }

  function splitHandForDisplay(view: { seat: number; hand: string[] } | undefined | null): HandParts {
    if (!view) return { closed: [], drawn: null }
    const pending = pendingDiscardBySeat.value[view.seat]
    if (!pending) return splitHandForView(view)

    const remaining = [...view.hand]
    if (pending.tsumogiri) {
      return { closed: remaining, drawn: HAND_DISCARD_GAP }
    }

    const revealed = remaining.some((tile) => tile !== '?')
    const lastDrawnTile = lastDrawBeforePendingDiscard(view.seat)
    let drawn: string | null = null
    if (lastDrawnTile && remaining.length) {
      if (revealed) {
        for (let index = remaining.length - 1; index >= 0; index -= 1) {
          if (remaining[index] !== lastDrawnTile) continue
          drawn = remaining.splice(index, 1)[0] || null
          break
        }
      } else {
        drawn = remaining.pop() || null
      }
    }

    if (!revealed) {
      const slotCount = remaining.length + 1
      remaining.splice(deterministicGapIndex(view.seat, pending.pai, slotCount), 0, HAND_DISCARD_GAP)
      return { closed: remaining, drawn }
    }

    const originalClosed = [...remaining, pending.pai].sort(compareHandTiles)
    const gapIndex = originalClosed.indexOf(pending.pai)
    if (gapIndex >= 0) originalClosed[gapIndex] = HAND_DISCARD_GAP
    return { closed: originalClosed, drawn }
  }

  const southHandParts = computed(() => splitHandForView(southView.value))
  const southDisplayHandParts = computed(() => splitHandForDisplay(southView.value))
  const eastDisplayHandParts = computed(() => splitHandForDisplay(eastView.value))
  const northDisplayHandParts = computed(() => splitHandForDisplay(northView.value))
  const westDisplayHandParts = computed(() => splitHandForDisplay(westView.value))

  const southHandDisplay = computed(() => (
    southHandParts.value.drawn
      ? [...southHandParts.value.closed, southHandParts.value.drawn]
      : [...southHandParts.value.closed]
  ))

  const southRonRiskSlots = computed(() => {
    const displayParts = southDisplayHandParts.value
    const visualSlots = [
      ...displayParts.closed.map((tile) => ({ tile, isDrawn: false })),
      ...(displayParts.drawn ? [{ tile: displayParts.drawn, isDrawn: true }] : []),
    ]
    return visualSlots.map(({ tile, isDrawn }, index) => {
      const isGap = tile === HAND_DISCARD_GAP
      const isConnectedTile = !isGap && !isDrawn
      const previous = visualSlots[index - 1]
      const next = visualSlots[index + 1]
      const tileIndex = tile34Index(tile)
      return {
        tile,
        index,
        isDrawn,
        isGap,
        connectLeft: isConnectedTile && Boolean(previous && previous.tile !== HAND_DISCARD_GAP && !previous.isDrawn),
        connectRight: isConnectedTile && Boolean(next && next.tile !== HAND_DISCARD_GAP && !next.isDrawn),
        risks: RON_WAIT_OPPONENT_KEYS.map((key) => ({
          key,
          probability: tileIndex === null
            ? 0
            : clampProbability(ronWaitPredData.value[key]?.[tileIndex]),
        })),
      }
    })
  })
  const southRonRiskAdaptiveMax = computed(() => adaptiveProbabilityScale(
    southRonRiskSlots.value.flatMap((slot) => slot.risks.map((risk) => risk.probability)),
  ))
  const showSouthRonRiskThreshold = computed(() => (
    southRonRiskAdaptiveMax.value > DEFAULT_PROBABILITY_SCALE
  ))

  const riverTsumogiriFlagsBySeat = computed(() => {
    const result = new Map<number, boolean[]>()
    const history = Array.isArray(gameView.table?.actionHistory) ? gameView.table?.actionHistory || [] : []
    history.forEach((raw) => {
      const action = raw as Record<string, unknown>
      if (String(action.type || '') !== 'dahai') return
      const actor = Number(action.actor ?? -1)
      if (actor < 0 || actor > 3) return
      const flags = result.get(actor) || []
      flags.push(Boolean(action.tsumogiri))
      result.set(actor, flags)
    })
    return result
  })

  const riverRiichiFlagsBySeat = computed(() => {
    const result = new Map<number, boolean[]>()
    const history = Array.isArray(gameView.table?.actionHistory) ? gameView.table?.actionHistory || [] : []
    history.forEach((raw) => {
      const action = raw as Record<string, unknown>
      if (String(action.type || '') !== 'dahai') return
      const actor = Number(action.actor ?? -1)
      if (actor < 0 || actor > 3) return
      const flags = result.get(actor) || []
      flags.push(Boolean(action.riichi))
      result.set(actor, flags)
    })
    return result
  })

  const claimedRiverIndicesBySeat = computed(() => {
    const result = new Map<number, Set<number>>()
    const landedCounts = [0, 0, 0, 0]
    const history = Array.isArray(gameView.table?.actionHistory) ? gameView.table?.actionHistory || [] : []
    history.forEach((raw) => {
      const action = raw as Record<string, unknown>
      const type = String(action.type || '')
      if (type === 'dahai') {
        const actor = Number(action.actor ?? -1)
        if (actor >= 0 && actor < 4) landedCounts[actor] += 1
        return
      }
      if (type !== 'chi' && type !== 'pon' && type !== 'daiminkan') return
      const from = Number(action.from ?? -1)
      if (from < 0 || from > 3) return
      const index = landedCounts[from] - 1
      if (index < 0) return
      let claimed = result.get(from)
      if (!claimed) {
        claimed = new Set<number>()
        result.set(from, claimed)
      }
      claimed.add(index)
    })
    return result
  })

  function riverDisplayRows(view: { seat: number; river: string[] } | undefined | null): RiverDisplaySlot[][] {
    if (!view) return []
    const pending = pendingDiscardBySeat.value[view.seat]
    const claimedIndices = claimedRiverIndicesBySeat.value.get(view.seat) || null
    const tsumogiriFlags = riverTsumogiriFlagsBySeat.value.get(view.seat) || []
    const riichiFlags = riverRiichiFlagsBySeat.value.get(view.seat) || []
    const visibleTiles = view.river.map((tile, landedIndex) => ({
      tile,
      landedIndex,
      isPending: false,
    }))
    if (pending) {
      visibleTiles.push({
        tile: pending.pai,
        landedIndex: -1,
        isPending: true,
      })
    }

    const slots = visibleTiles.map((entry, visibleIndex): RiverDisplaySlot => ({
      key: `${view.seat}-${visibleIndex}`,
      tile: entry.tile,
      sourceNodeId: tableActionNodeIndex.value.discardNodeIdsBySeat[view.seat]?.[
        entry.isPending ? view.river.length : entry.landedIndex
      ] || null,
      isPending: entry.isPending,
      isTsumogiri: entry.isPending ? Boolean(pending?.tsumogiri) : entry.landedIndex >= 0 && Boolean(tsumogiriFlags[entry.landedIndex]),
      isClaimed: !entry.isPending && entry.landedIndex >= 0 && Boolean(claimedIndices?.has(entry.landedIndex)),
      isRiichiDiscard: entry.isPending ? Boolean(pending?.riichi) : entry.landedIndex >= 0 && Boolean(riichiFlags[entry.landedIndex]),
    }))
    return [slots.slice(0, 6), slots.slice(6, 12), slots.slice(12)].filter((row) => row.length > 0)
  }


  return {
    HAND_DISCARD_GAP,
    tableSeatViews,
    southView,
    northView,
    eastView,
    westView,
    discardActions,
    specialActions,
    showTreeComparisons,
    centerDoraSlots,
    southDiscardBarSlots,
    southLaneStyle,
    canJumpToHistoricalNode,
    historicalJumpTitle,
    jumpToHistoricalNode,
    meldNodeId,
    meldDisplayTiles,
    southDisplayHandParts,
    eastDisplayHandParts,
    northDisplayHandParts,
    westDisplayHandParts,
    southHandDisplay,
    southRonRiskSlots,
    southRonRiskAdaptiveMax,
    showSouthRonRiskThreshold,
    riverDisplayRows,
  }
}
