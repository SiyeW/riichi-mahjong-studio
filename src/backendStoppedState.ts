export function backendStoppedState(status: TrainerStatusSnapshot): TrainerStatusSnapshot {
  return {
    ...status,
    gameLoaded: false,
    pendingSeatSwitch: null,
    aiThinkingTimeS: 0,
    modelRuntime: {
      decision: { profileId: '', ready: false, unloaded: true },
      opponentAnalysis: { profileId: '', ready: false, unloaded: true },
    },
    modelActivity: {
      decision: ['idle', 'idle', 'idle', 'idle'], opponentAnalysis: 'idle',
      errors: { decision: [null, null, null, null], opponentAnalysis: null },
    },
    autoAnalysis: {
      ...status.autoAnalysis,
      status: status.autoAnalysis.status === 'running' ? 'canceled' : status.autoAnalysis.status,
      currentNodeId: null, currentModel: null,
    },
  }
}
