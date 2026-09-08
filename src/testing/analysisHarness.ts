import type { AnalysisCountLayout } from '../analysisCountSpacing'

// Explicit fixture controls for the isolated renderer. This module is only
// installed in Vite's ui-test mode, never in the desktop application.
export interface AnalysisTestApi {
  recordDirty: boolean
  readonly recordPath: string
  saveGame: () => Promise<void>
  saveGameAs: () => Promise<void>
  status: TrainerStatusSnapshot
  gameView: TrainerGameView
  settings: TrainerSettings
  readonly workspaceLayout: TrainerSettings['display']['workspaceLayout']
  analysisCountLayout: AnalysisCountLayout
  readonly showPerceptualColorDebugger: boolean
  readonly bootstrapError: string
  readonly tileArtworkReady: boolean
  readonly opponentAnalysisIsLoading: boolean
  readonly showWallView: boolean
  readonly wallTiles: Array<{ index: number; tile: string; status: string }>
  readonly showEngineWindow: boolean
  showMjaiDebug: boolean
  handlePythonEvent: (event: TrainerPythonEvent) => void
  fetchShantenOnce: () => Promise<void>
  jumpToNode: (nodeId: string) => Promise<void>
  toggleAnalysisDock: () => void
  clearLoadedAnalysisCaches: () => Promise<void>
  openWallView: () => Promise<void>
  closeWallView: (clearResult?: boolean) => void
  openEngineWindow: () => void
  closeEngineWindow: () => void
}

declare global {
  interface Window {
    setupRmsAnalysisTest?: (api: AnalysisTestApi) => void
  }
}

export function installAnalysisTestHarness(api: AnalysisTestApi) {
  window.setupRmsAnalysisTest?.(api)
}
