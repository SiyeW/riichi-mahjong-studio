import type { AnalysisCountLayout } from '../analysisCountSpacing'

// Explicit fixture controls for the isolated renderer. This module is only
// installed in Vite's ui-test mode, never in the desktop application.
export interface AnalysisTestApi {
  status: TrainerStatusSnapshot
  gameView: TrainerGameView
  settings: TrainerSettings
  readonly workspaceLayout: TrainerSettings['display']['workspaceLayout']
  analysisCountLayout: AnalysisCountLayout
  readonly showPerceptualColorDebugger: boolean
  readonly bootstrapError: string
  readonly tileArtworkReady: boolean
  readonly opponentAnalysisIsLoading: boolean
  handlePythonEvent: (event: TrainerPythonEvent) => void
  fetchShantenOnce: () => Promise<void>
  toggleAnalysisDock: () => void
  clearLoadedAnalysisCaches: () => Promise<void>
}

declare global {
  interface Window {
    setupRmsAnalysisTest?: (api: AnalysisTestApi) => void
  }
}

export function installAnalysisTestHarness(api: AnalysisTestApi) {
  window.setupRmsAnalysisTest?.(api)
}
