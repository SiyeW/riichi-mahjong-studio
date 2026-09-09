/// <reference types="vite/client" />

// Transitional aliases keep existing renderer modules type-safe while their
// imports move to the authoritative contracts. Remove this block after the
// migration; business contracts must not remain ambient.
type TrainerAutoAnalysisStatus = import('./contracts/runtime').AutoAnalysisStatus
type TrainerStatusSnapshot = import('./contracts/runtime').StudioStatus
type TrainerRuntimeMetrics = import('./contracts/runtime').RuntimeMetrics
type TrainerRecordImportResult = import('./contracts/runtime').RecordImportResult
type TrainerGameView = import('./contracts/game').GameView
type TrainerEnvironmentResponse = import('./contracts/runtime').EnvironmentResponse
type TrainerPythonEvent = import('./contracts/runtime').PythonEvent

interface Window {
  trainerAPI?: import('./contracts/desktopBridge').DesktopBridge
}

declare module '*.json' {
  const value: Record<string, string>
  export default value
}
