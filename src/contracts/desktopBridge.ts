import type { EngineDescription, EngineSettings } from './engines'
import type { GameView } from './game'
import type {
  EnvironmentResponse,
  PythonEvent,
  RecordImportResult,
  RuntimeMetrics,
  StudioStatus,
} from './runtime'
import type { SettingsPatch, StudioSettings } from './settings'

export interface RecordFileResult {
  path: string
  state: StudioStatus
  view: GameView
  recordDirty: boolean
  recoveryRecord: boolean
}

export interface DesktopBridge {
  getSettings: () => Promise<StudioSettings>
  saveSettings: (settings: SettingsPatch) => Promise<StudioSettings>
  describeEngine: (profile: {
    engineId?: string
    engineVersion?: string
    enginePath: string
    engineCommand?: string[]
    engineCwd?: string
  }) => Promise<EngineDescription>
  chooseEngineFile: () => Promise<string>
  chooseEngineWeight: () => Promise<string>
  activateEngine: (payload: {
    profileId: string
    engines: EngineSettings
  }) => Promise<StudioSettings>
  unloadEngine: (payload: { profileId: string }) => Promise<{
    state: StudioStatus
    settings: StudioSettings
  }>
  getStatus: () => Promise<StudioStatus>
  getRuntimeMetrics: () => Promise<RuntimeMetrics>
  getGameView: () => Promise<EnvironmentResponse>
  createGame: () => Promise<StudioStatus>
  closeGame: () => Promise<EnvironmentResponse>
  advanceGame: () => Promise<EnvironmentResponse>
  confirmPendingReview: () => Promise<EnvironmentResponse>
  submitUserAction: (action: {
    type: string
    pai?: string
    variant?: string
    fromDrawn?: boolean
    candidateId?: string
  }) => Promise<EnvironmentResponse>
  jumpToNode: (nodeId: string, treeRevision?: number) => Promise<EnvironmentResponse>
  setMainBranch: (nodeId: string) => Promise<EnvironmentResponse>
  setNodeComment: (nodeId: string, comment: string) => Promise<{
    request_id: string
    command: string
    nodeId: string
    comment: string
    changed: boolean
    timestamp: string
  }>
  deleteNode: (nodeId: string) => Promise<EnvironmentResponse>
  getRecordDirty: () => Promise<boolean>
  saveGame: () => Promise<RecordFileResult | null>
  saveGameAs: () => Promise<RecordFileResult | null>
  openGame: () => Promise<RecordFileResult | null>
  showRecordInFolder: () => Promise<boolean>
  restoreStartupRecovery: () => Promise<RecordFileResult | null>
  importMortalReport: (payload: {
    input: string
    reconstructWalls?: boolean
    seed?: string
  }) => Promise<RecordImportResult>
  importCustomTenhou: (payload: {
    input: string
    reconstructWalls?: boolean
    seed?: string
  }) => Promise<RecordImportResult>
  exportCustomTenhou: () => Promise<{
    tenhou: string
    mortal: string
    naga: string
  }>
  setMode: (mode: 'play' | 'research') => Promise<StudioStatus>
  requestSeatSwitch: (seat: number) => Promise<StudioStatus>
  toggleVisibleHands: () => Promise<StudioStatus>
  setAnalysisVisibility: (visibility: {
    decisionRecommendations?: boolean
    opponentAnalysis?: boolean
  }) => Promise<EnvironmentResponse>
  restartBackend: () => Promise<{ ok: boolean }>
  getWallView: () => Promise<{
    tiles: Array<{ index: number; tile: string; status: string }>
    complete: boolean
    canReconstruct: boolean
    seed: number | null
    origin: 'generated' | 'imported' | 'reconstructed'
    sourceUrl: string | null
  }>
  reconstructWalls: (seed?: string) => Promise<EnvironmentResponse & {
    reconstruction: { seed: number; roundCount: number }
  }>
  importWall: (tiles: string[]) => Promise<EnvironmentResponse>
  getLatestMjaiDebug: () => Promise<{ debug: Record<string, unknown> }>
  getAnalysis: () => Promise<Record<string, unknown>>
  getAnalysisDebug: () => Promise<{ debug: Record<string, unknown> }>
  clearAnalysisCaches: () => Promise<{
    state: StudioStatus
    cleared: {
      decisionEntries: number
      decisionCacheEpoch: number
      opponentCacheEpoch: number
      opponentEntries: number
      comparisons: number
      pendingReview: boolean
      treeRevision: number
    }
  }>
  startAutoAnalysis: () => Promise<EnvironmentResponse>
  cancelAutoAnalysis: () => Promise<EnvironmentResponse>
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
  onPythonEvent: (callback: (event: PythonEvent) => void) => () => void
  onRecordDirtyChanged: (callback: (dirty: boolean) => void) => () => void
  onBeforeClose: (callback: () => void | Promise<void>) => () => void
}
