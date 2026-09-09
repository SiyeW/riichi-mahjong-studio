export interface EngineProfile {
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

export interface DecisionMetricDefinition {
  id: string
  title: string | Record<string, string>
  description?: string | Record<string, string>
  format: 'number' | 'percentage' | 'points'
  preferredDirection: 'higher' | 'lower' | 'none'
  fractionDigits?: number
}

export interface EngineDescription {
  protocol: { name: string; major: number; minor?: number }
  engine: {
    id: string
    name: string
    version: string
  }
  outputContracts: Array<{
    id: string
    version?: number
    representations?: string[]
    supportsRevealedHands?: boolean
    metrics?: DecisionMetricDefinition[]
  }>
  weightSlots: Array<{
    id: string
    title: string | Record<string, string>
    formats: Array<{ id: string; extensions?: string[] }>
    requiredForOutputs?: Array<{ id: string; version?: number }>
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

export type EngineOutputId =
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
  | 'match-score'

export interface EngineSettings {
  schemaVersion: number
  profiles: EngineProfile[]
  outputAssignments: Record<EngineOutputId, string>
  loadedProfileIds: string[]
}

export type ModelActivityState = 'idle' | 'loading' | 'running' | 'error'

export interface ModelRuntimeState {
  profileId: string
  profileIds?: string[]
  profiles?: Record<string, {
    ready: boolean
    unloaded: boolean
    error?: string
  }>
  ready: boolean
  unloaded: boolean
}
