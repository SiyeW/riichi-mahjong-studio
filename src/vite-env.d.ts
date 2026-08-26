/// <reference types="vite/client" />

interface TrainerSettings {
  configPath: string
  runtime?: {
    releaseMode: boolean
    builtInRuntimeLabel: string
    builtInModelLabel: string
    opponentAnalysisInputModes: Array<'public' | 'full-information'>
      engineCatalog: {
        schemaVersion: number
        engines: Array<{
        id: string
        name: string
        version: string
          builtIn: boolean
          enginePath: string
          protocol: { name: string; major: number; minor: number }
        licenses: Array<{ name: string; available: boolean }>
        notices: Array<{ name: string; available: boolean }>
        sourceUrl: string
        launch: {
          executable: string
          arguments: string[]
          cwd: string
        } | null
      }>
      diagnostics: Array<{
        severity: 'error' | 'warning'
        code: string
        path: string
        message: string
      }>
    }
    soundPackCatalog: {
      schemaVersion: number
      packs: Array<{
        id: string
        name: string
        version: string
        builtIn: boolean
        sounds: Record<string, string>
      }>
      diagnostics: Array<{
        severity: 'error' | 'warning'
        code: string
        path: string
        message: string
      }>
    }
  }
  training: {
    mode: 'no_review' | 'threshold_review' | 'always_review' | 'preview_before_click'
    mistakeThreshold: number
    thinkingTimeMinS: number
    thinkingTimeMaxS: number
  }
  modeDefaults: {
    autoAdvanceDelayMs: number
  }
  display: {
    language: 'system' | 'zh-CN' | 'ja-JP' | 'en-US'
    colorScheme: 'default' | 'killerducky'
    reduceMotion: boolean
    uiScale: number
    showTsumogiriInPlay: boolean
    tablePosition: 'left' | 'center' | 'right'
    workspaceLayout: {
      layout: WorkspaceDockNode
      analysisVisible: boolean
      analysisPanels: {
        opponents: boolean
        game: boolean
        risk: boolean
        counts: boolean
      }
      consoleVisible: boolean
    }
  }
  records: {
    saveRecoveryOnExit: boolean
  }
  audio: {
    volume: number
    soundPackId: string
  }
  engines: TrainerEngineSettings
}

interface TrainerEngineProfile {
  id: string
  name: string
  engineId: string
  enginePath: string
  builtIn: boolean
  autoName?: boolean
  available: boolean
  unavailableReason?: string
  engineVersion?: string
  engineCommand?: string[]
  engineCwd?: string
  weights: Array<{ slotId: string; format: string; path: string }>
  device: string
  options: {
    botVersion?: 'v3' | 'v4'
    temperature?: number
    [key: string]: unknown
  }
}

interface TrainerDecisionMetricDefinition {
  id: string
  title: string | Record<string, string>
  description?: string | Record<string, string>
  format: 'number' | 'percentage' | 'points'
  preferredDirection: 'higher' | 'lower' | 'none'
  fractionDigits?: number
}

interface TrainerEngineDescription {
  protocol: { name: string; major: number; minor?: number }
  engine: {
    id: string
    name: string
    version: string
  }
  outputContracts: Array<{
    id: string
    version: number
    representations?: string[]
    supportsRevealedHands?: boolean
    metrics?: TrainerDecisionMetricDefinition[]
  }>
  weightSlots: Array<{
    id: string
    title: string | Record<string, string>
    formats: Array<{ id: string; extensions?: string[] }>
    requiredForOutputs?: Array<{ id: string; version: number }>
  }>
  devices: Array<{
    type: string
    title?: string | Record<string, string>
  }>
  runtimeCapabilities: Record<string, boolean>
  optionsSchema: {
    type?: string
    properties?: Record<string, {
      type?: 'string' | 'number' | 'integer' | 'boolean'
      enum?: Array<string | number | boolean>
      default?: unknown
      minimum?: number
      maximum?: number
      'x-ui'?: { label?: string; control?: string }
    }>
  }
}

interface TrainerEngineSettings {
  schemaVersion: number
  profiles: TrainerEngineProfile[]
  outputAssignments: Record<
    | 'action-recommendation'
    | 'opponent-shanten'
    | 'opponent-deal-in-probability'
    | 'opponent-concealed-tile-count'
    | 'wall-tile-count'
    | 'opponent-dora-count'
    | 'opponent-score'
    | 'kyoku-outcome'
    | 'kyoku-score-delta'
    | 'match-placement'
    | 'match-score',
    string
  >
  loadedProfileIds: string[]
}

type TrainerModelActivityState = 'idle' | 'loading' | 'running' | 'error'

interface TrainerModelRuntimeState {
  profileId: string
  profileIds?: string[]
  profiles?: Record<string, {
    ready: boolean
    unloaded: boolean
  }>
  ready: boolean
  unloaded: boolean
}

interface TrainerAutoAnalysisStatus {
  status: 'idle' | 'running' | 'canceled' | 'completed'
  completed: number
  total: number
  cached: number
  analyzed: number
  failed: number
  currentNodeId: string | null
  currentModel: 'decision' | 'opponent' | null
  message: string
  timeline: string
  timelineReady: number
}

interface TrainerStatusSnapshot {
  mode: 'play' | 'research'
  controlledSeat: number
  pendingSeatSwitch: number | null
  visibleHands: boolean
  gameLoaded: boolean
  aiThinkingTimeS: number
  device: string
  modelPerformance: {
    decision: number[]
    opponentAnalysis: number
  }
  analysisVisibility: {
    decisionRecommendations: boolean
    opponentAnalysis: boolean
  }
  modelActivity: {
    decision: TrainerModelActivityState[]
    opponentAnalysis: TrainerModelActivityState
    errors?: {
      decision: Array<string | null>
      opponentAnalysis: string | null
    }
  }
  modelRuntime: {
    decision: TrainerModelRuntimeState
    opponentAnalysis: TrainerModelRuntimeState
  }
  autoAnalysis: TrainerAutoAnalysisStatus
}

interface TrainerRuntimeMetrics {
  applicationBytes: number | null
  electronBytes: number
  backendBytes: number | null
  engineBytes: number | null
  backendAvailable: boolean
  electronProcessCount: number
  engineProcessCount: number | null
  systemAvailableBytes: number
  systemTotalBytes: number
  sampledAt: number
}

interface TrainerRecordImportResult {
  sourceUrl?: string
  reconstruction?: { seed: number; roundCount: number } | null
  state: TrainerStatusSnapshot
  view: TrainerGameView
  recordDirty: boolean
}

interface TrainerAction {
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

interface TrainerTreeNode {
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
  comparison?: {
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
  } | null
  isCurrent: boolean
}

interface TrainerResultInfo {
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

interface TrainerRoundSummary {
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
  resultInfo?: TrainerResultInfo | null
  matchEndInfo?: TrainerResultInfo | null
  isCurrent: boolean
}

interface TrainerGameView {
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
  table: {
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
    resultInfo?: TrainerResultInfo | null
  } | null
  legalActions: TrainerAction[]
  analysis: {
    model: string
    seat: number
    mode?: string
    bestAction?: Record<string, unknown> | null
    metricDefinitions?: TrainerDecisionMetricDefinition[]
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
  } | null
  comparison: {
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
    valueGap: number
    probabilityGap: number
    chosenRank: number
  } | null
  pendingReview: {
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
    comparison: {
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
  } | null
  tree: {
    rootNodeId: string
    currentNodeId: string
    mainLeafNodeId: string
    currentRoundRootId?: string | null
    revision?: number
    viewSeat?: number
    compact?: boolean
    nodes?: TrainerTreeNode[] | Record<string, TrainerTreeNode>
    rounds?: TrainerRoundSummary[]
  } | null
}

interface TrainerEnvironmentResponse {
  request_id: string
  command: string
  state: TrainerStatusSnapshot
  view: TrainerGameView
  timestamp: string
  playPrefetch?: {
    generation: number
    ready: boolean
    waiting: boolean
    finished: boolean
    committed?: boolean
    fallback?: boolean
    error?: string | null
  }
}

interface TrainerPythonEvent {
  type: string
  model?: 'decision' | 'opponent_analysis'
  seat?: number
  active?: boolean
  activityState?: TrainerModelActivityState
  error?: string | null
  averageMs?: number
  runtime?: TrainerModelRuntimeState
  opponentAnalysis?: Record<string, unknown>
  nodeId?: string
  gameId?: string
  analysisKey?: string
  analysis?: TrainerGameView['analysis']
  treeComparisons?: Array<{
    id: string
    comparison: TrainerTreeNode['comparison']
  }>
  treeRevision?: number | null
  generation?: number
  state?: TrainerStatusSnapshot
  autoAnalysis?: TrainerAutoAnalysisStatus
  timestamp?: string
}

interface Window {
  trainerAPI?: {
    getSettings: () => Promise<TrainerSettings>
    saveSettings: (settings: Partial<TrainerSettings>) => Promise<TrainerSettings>
    describeEngine: (profile: {
      engineId?: string
      engineVersion?: string
      enginePath: string
      engineCommand?: string[]
      engineCwd?: string
    }) => Promise<TrainerEngineDescription>
    chooseEngineFile: () => Promise<string>
    chooseEngineWeight: () => Promise<string>
    activateEngine: (payload: {
      profileId: string
      engines: TrainerEngineSettings
    }) => Promise<TrainerSettings>
    unloadEngine: (payload: {
      profileId: string
    }) => Promise<{
      state: TrainerStatusSnapshot
      settings: TrainerSettings
    }>
    getStatus: () => Promise<TrainerStatusSnapshot>
    getRuntimeMetrics: () => Promise<TrainerRuntimeMetrics>
    getGameView: () => Promise<TrainerEnvironmentResponse>
    createGame: () => Promise<TrainerStatusSnapshot>
    closeGame: () => Promise<TrainerEnvironmentResponse>
    advanceGame: () => Promise<TrainerEnvironmentResponse>
    confirmPendingReview: () => Promise<TrainerEnvironmentResponse>
    submitUserAction: (action: { type: string; pai?: string; variant?: string; fromDrawn?: boolean; candidateId?: string }) => Promise<TrainerEnvironmentResponse>
    jumpToNode: (nodeId: string, treeRevision?: number) => Promise<TrainerEnvironmentResponse>
    setMainBranch: (nodeId: string) => Promise<TrainerEnvironmentResponse>
    setNodeComment: (nodeId: string, comment: string) => Promise<{
      request_id: string
      command: string
      nodeId: string
      comment: string
      changed: boolean
      timestamp: string
    }>
    deleteNode: (nodeId: string) => Promise<TrainerEnvironmentResponse>
    getRecordDirty: () => Promise<boolean>
    saveGame: () => Promise<{ path: string; state: TrainerStatusSnapshot; view: TrainerGameView; recordDirty: boolean; recoveryRecord: boolean } | null>
    saveGameAs: () => Promise<{ path: string; state: TrainerStatusSnapshot; view: TrainerGameView; recordDirty: boolean; recoveryRecord: boolean } | null>
    openGame: () => Promise<{ path: string; state: TrainerStatusSnapshot; view: TrainerGameView; recordDirty: boolean; recoveryRecord: boolean } | null>
    showRecordInFolder: () => Promise<boolean>
    restoreStartupRecovery: () => Promise<{ path: string; state: TrainerStatusSnapshot; view: TrainerGameView; recordDirty: boolean; recoveryRecord: boolean } | null>
    importMortalReport: (payload: {
      input: string
      reconstructWalls?: boolean
      seed?: string
    }) => Promise<TrainerRecordImportResult>
    importCustomTenhou: (payload: {
      input: string
      reconstructWalls?: boolean
      seed?: string
    }) => Promise<TrainerRecordImportResult>
    exportCustomTenhou: () => Promise<{
      tenhou: string
      mortal: string
      naga: string
    }>
    setMode: (mode: 'play' | 'research') => Promise<TrainerStatusSnapshot>
    requestSeatSwitch: (seat: number) => Promise<TrainerStatusSnapshot>
    toggleVisibleHands: () => Promise<TrainerStatusSnapshot>
    setAnalysisVisibility: (visibility: {
      decisionRecommendations?: boolean
      opponentAnalysis?: boolean
    }) => Promise<TrainerEnvironmentResponse>
    restartBackend: () => Promise<{ ok: boolean }>
    getWallView: () => Promise<{
      tiles: Array<{ index: number; tile: string; status: string }>
      complete: boolean
      canReconstruct: boolean
      seed: number | null
      origin: 'generated' | 'imported' | 'reconstructed'
      sourceUrl: string | null
    }>
    reconstructWalls: (seed?: string) => Promise<TrainerEnvironmentResponse & {
      reconstruction: { seed: number; roundCount: number }
    }>
    importWall: (tiles: string[]) => Promise<TrainerEnvironmentResponse>
    getLatestMjaiDebug: () => Promise<{ debug: Record<string, unknown> }>
    getShanten: () => Promise<{ opponents: Record<string, number[]> }>
    getShantenMjai: () => Promise<{ debug: Record<string, unknown> }>
    clearAnalysisCaches: () => Promise<{
      state: TrainerStatusSnapshot
      cleared: {
        decisionEntries: number
        opponentEntries: number
        comparisons: number
        pendingReview: boolean
        treeRevision: number
      }
    }>
    startAutoAnalysis: () => Promise<TrainerEnvironmentResponse>
    cancelAutoAnalysis: () => Promise<TrainerEnvironmentResponse>
    readClipboardText: () => Promise<string>
    writeClipboardText: (text: string) => Promise<{ ok: boolean }>
    openExternal: (url: string) => Promise<boolean>
    openAppLegalDocument: (documentId: 'license' | 'thirdPartyNotices') => Promise<boolean>
    openEngineLegalDocument: (payload: {
      engineId: string
      kind: 'license' | 'notice'
      index: number
    }) => Promise<boolean>
    onUiZoomShortcut: (callback: (direction: 'in' | 'out' | 'reset') => void) => () => void
    onPythonEvent: (callback: (event: TrainerPythonEvent) => void) => () => void
    onRecordDirtyChanged: (callback: (dirty: boolean) => void) => () => void
    onBeforeClose: (callback: () => void | Promise<void>) => () => void
  }
}

type WorkspaceDockItemId =
  | 'table'
  | 'console'
  | 'analysis-opponents'
  | 'analysis-game'
  | 'analysis-risk'
  | 'analysis-counts'

type WorkspaceDockNode =
  | { type: 'item'; id: WorkspaceDockItemId }
  | {
      type: 'split'
      direction: 'horizontal' | 'vertical'
      children: WorkspaceDockNode[]
      weights: number[]
    }

declare module '*.json' {
  const value: Record<string, string>
  export default value
}
