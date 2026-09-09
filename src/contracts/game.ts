export interface GameAction {
  id: string
  candidateId?: string
  type: string
  actor: number
  pai?: string
  variant?: string
  reasonLabel?: string
  consumed?: string[]
  label: string
  value?: number
  probability?: number
  bar?: number
  tsumogiri?: boolean
}

export interface DecisionComparison {
  actor: number
  phase?: string
  chosenKey: string
  bestKey: string
  chosenLabel: string
  bestLabel: string
  chosenPai?: string | null
  bestPai?: string | null
  isBest: boolean
  chosenValue: number
  bestValue: number
  chosenProbability: number
  bestProbability: number
  chosenBar?: number | null
  bestBar?: number | null
  valueGap: number
  probabilityGap: number
  chosenRank: number
}

export interface GameTreeNode {
  id: string
  parentId: string | null
  children: string[]
  mainChildId: string | null
  depth: number
  roundDepth?: number
  roundRootId?: string
  roundIndex?: number
  bakaze?: string | null
  kyoku?: number | null
  honba?: number
  kyotaku?: number
  scores?: number[]
  phase?: string | null
  type: string
  action: Record<string, unknown> | null
  isDecision?: boolean
  comparison?: DecisionComparison | null
  isCurrent: boolean
}

export interface GameResultInfo {
  eventType: string
  title: string
  detail: string
  reason?: string | null
  scores: number[]
  ranks?: number[]
  deltas: number[]
  actor?: number
  target?: number
  han?: number
  fu?: number
  yaku?: string[]
  yakuDetails?: Array<{
    name: string
    han: number
    isYakuman: boolean
  }>
  uraMarkers?: string[]
  isOpenHand?: boolean
  cost?: {
    main?: number
    additional?: number
    main_bonus?: number
    additional_bonus?: number
    kyoutaku_bonus?: number
    total?: number
    yaku_level?: string
  }
}

export interface RoundSummary {
  id: string
  parentRoundId: string | null
  childRoundIds: string[]
  mainNextRoundId: string | null
  depth: number
  roundIndex: number
  bakaze?: string | null
  kyoku?: number | null
  honba?: number
  kyotaku?: number
  scores?: number[]
  phase?: string | null
  tailScores?: number[]
  tailPhase?: string | null
  resultInfo?: GameResultInfo | null
  matchEndInfo?: GameResultInfo | null
  isCurrent: boolean
}

export interface TableState {
  matchId?: string | null
  bakaze: string
  kyoku: number
  honba: number
  kyotaku: number
  roundIndex?: number
  westEntered?: boolean
  dealer: number
  currentActor: number
  phase: string
  turn: number
  drawIndex: number
  lastDrawnSeat?: number | null
  lastDrawnTile?: string | null
  autoAdvanceMode?: string | null
  wallRemaining: number
  doraIndicators: string[]
  uraIndicators?: string[]
  scores: number[]
  hands: string[][]
  rivers: string[][]
  melds: Array<Array<Record<string, unknown>>>
  actionHistory?: Array<Record<string, unknown>>
  riichiDeclared?: boolean[]
  riichiAccepted?: boolean[]
  pendingRiichiSeat?: number | null
  riichiDiscardState?: string | null
  pendingRiichiDiscard?: {
    actor: number
    pai: string
    tsumogiri: boolean
    targetActor: number
    riichi?: boolean
  } | null
  pendingKan?: {
    actor: number
    pai: string
    target?: number
    variant?: string
    label?: string
    source?: string
  } | null
  pendingDiscard: {
    actor: number
    pai: string
    tsumogiri: boolean
    targetActor: number
    riichi?: boolean
  } | null
  reactionWindow: {
    discard: {
      actor: number
      pai: string
      tsumogiri: boolean
      targetActor: number
    }
    thinkingTimeS?: number
    reactions: Array<{
      seat: number
      response: Record<string, unknown>
      priority: number
    }>
    selected: {
      seat: number
      response: Record<string, unknown>
      priority: number
    }
  } | null
  kanReactionWindow?: {
    kan: {
      actor: number
      pai: string
      variant?: string
    }
    thinkingTimeS?: number
    reactions: Array<{
      seat: number
      response: Record<string, unknown>
      priority: number
    }>
    selected: {
      seat: number
      response: Record<string, unknown>
      priority: number
    }
  } | null
  lastAction: {
    type: string
    actor: number
    pai?: string
    reason?: string
    reasonLabel?: string
    tsumogiri?: boolean
    consumed?: string[]
    target?: number
    variant?: string
    riichi?: boolean
    source?: string
  } | null
  resultInfo?: GameResultInfo | null
}

export interface DecisionAnalysis {
  model: string
  seat: number
  mode?: string
  bestAction?: Record<string, unknown> | null
  metricDefinitions?: import('./engines').DecisionMetricDefinition[]
  primaryMetricId?: string
  recommendationMetricId?: string
  discardEntries: Array<{
    candidateId?: string
    scoreGroupId?: string
    pai: string
    tsumogiri?: boolean
    value: number
    probability?: number
    rank?: number
    bar?: number
    isBest?: boolean
    metrics?: Record<string, number | null>
  }>
  specialEntries?: Array<{
    candidateId?: string
    scoreGroupId?: string
    type: string
    variant: string
    label: string
    pai?: string
    consumed?: string[]
    value: number
    probability?: number
    rank?: number
    bar?: number
    isBest?: boolean
    metrics?: Record<string, number | null>
  }>
  reactionEntries?: Array<{
    candidateId?: string
    scoreGroupId?: string
    type: string
    variant: string
    label: string
    pai?: string
    consumed?: string[]
    value: number
    probability?: number
    rank?: number
    bar?: number
    isBest?: boolean
    metrics?: Record<string, number | null>
  }>
  error?: string
}

export interface PendingReview {
  phase: string
  parentNodeId: string
  proposedNodeId: string
  chosenKey: string
  chosenFromDrawn?: boolean
  bestKey: string
  chosenPai?: string | null
  bestPai?: string | null
  chosenLabel: string
  bestLabel: string
  comparison: DecisionComparison
}

export interface GameTreeView {
  rootNodeId: string
  currentNodeId: string
  mainLeafNodeId: string
  currentRoundRootId?: string | null
  revision?: number
  viewSeat?: number
  compact?: boolean
  nodes?: GameTreeNode[] | Record<string, GameTreeNode>
  rounds?: RoundSummary[]
}

export interface GameView {
  gameId: string | null
  matchId?: string | null
  readOnly?: boolean
  sourceUrl?: string | null
  readOnlyReason?: string | null
  currentNodeId: string | null
  nodeComment: string
  opponentAnalysis?: Record<string, unknown> | null
  matchSummary?: {
    matchId: string
    matchType: string
    roundIndex: number
    bakaze: string
    kyoku: number
    honba: number
    kyotaku: number
    scores: number[]
    dealer: number
    westEntered: boolean
    ended: boolean
  } | null
  table: TableState | null
  legalActions: GameAction[]
  analysis: DecisionAnalysis | null
  comparison: DecisionComparison | null
  pendingReview: PendingReview | null
  tree: GameTreeView | null
}
