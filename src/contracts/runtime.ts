import type { ModelActivityState, ModelRuntimeState } from './engines'
import type { GameTreeNode, GameView } from './game'

export interface AutoAnalysisStatus {
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

export interface StudioStatus {
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
    decision: ModelActivityState[]
    opponentAnalysis: ModelActivityState
    errors?: {
      decision: Array<string | null>
      opponentAnalysis: string | null
    }
  }
  modelRuntime: {
    decision: ModelRuntimeState
    opponentAnalysis: ModelRuntimeState
  }
  autoAnalysis: AutoAnalysisStatus
}

export interface RuntimeMetrics {
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

export interface RecordImportResult {
  sourceUrl?: string
  reconstruction?: { seed: number; roundCount: number } | null
  state: StudioStatus
  view: GameView
  recordDirty: boolean
}

export interface BackendResponse {
  request_id: string
  command: string
  state: StudioStatus
  view: GameView
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

export interface PythonEvent {
  hasCheckpoint?: boolean
  view?: GameView
  type: string
  model?: 'decision' | 'opponent_analysis'
  seat?: number
  active?: boolean
  activityState?: ModelActivityState
  error?: string | null
  averageMs?: number
  runtime?: ModelRuntimeState
  opponentAnalysis?: Record<string, unknown>
  nodeId?: string
  gameId?: string
  analysisKey?: string
  cacheEpoch?: number
  analysis?: GameView['analysis']
  treeComparisons?: Array<{
    id: string
    comparison: GameTreeNode['comparison']
  }>
  treeRevision?: number | null
  generation?: number
  state?: StudioStatus
  autoAnalysis?: AutoAnalysisStatus
  timestamp?: string
}
