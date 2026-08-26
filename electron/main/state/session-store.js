function createInitialSnapshot() {
  return {
    mode: 'play',
    controlledSeat: 0,
    pendingSeatSwitch: null,
    visibleHands: false,
    gameLoaded: false,
    device: '...',
    modelPerformance: {
      decision: [0, 0, 0, 0],
      opponentAnalysis: 0,
    },
    analysisVisibility: {
      decisionRecommendations: true,
      opponentAnalysis: false,
    },
    modelActivity: {
      decision: ['idle', 'idle', 'idle', 'idle'],
      opponentAnalysis: 'idle',
      errors: {
        decision: [null, null, null, null],
        opponentAnalysis: null,
      },
    },
    modelRuntime: {
      decision: { profileId: '', ready: false, unloaded: false },
      opponentAnalysis: { profileId: '', ready: false, unloaded: false },
    },
    autoAnalysis: {
      status: 'idle',
      completed: 0,
      total: 0,
      cached: 0,
      analyzed: 0,
      failed: 0,
      currentNodeId: null,
      currentModel: null,
      message: '',
      timeline: '',
      timelineReady: 0,
    },
  }
}

function normalizeActivityState(value) {
  return ['idle', 'loading', 'running', 'error'].includes(value) ? value : 'idle'
}

function normalizeRuntimeState(value = {}) {
  const profileIds = Array.isArray(value.profileIds)
    ? [...new Set(value.profileIds.map(String).filter(Boolean))]
    : []
  const profiles = value.profiles && typeof value.profiles === 'object'
    ? Object.fromEntries(Object.entries(value.profiles).map(([profileId, state]) => [
      String(profileId),
      {
        ready: Boolean(state?.ready),
        unloaded: Boolean(state?.unloaded),
      },
    ]))
    : {}
  return {
    profileId: String(value.profileId || ''),
    profileIds,
    profiles,
    ready: Boolean(value.ready),
    unloaded: Boolean(value.unloaded),
  }
}

function normalizeSnapshot(payload = {}) {
  return {
    mode: payload.mode === 'research' ? 'research' : 'play',
    controlledSeat: Number.isInteger(payload.controlledSeat) ? payload.controlledSeat : 0,
    pendingSeatSwitch: Number.isInteger(payload.pendingSeatSwitch) ? payload.pendingSeatSwitch : null,
    visibleHands: Boolean(payload.visibleHands),
    gameLoaded: Boolean(payload.gameLoaded),
    device: String(payload.device || '...'),
    modelPerformance: {
      decision: [0, 1, 2, 3].map((seat) => Number(payload.modelPerformance?.decision?.[seat] || 0)),
      opponentAnalysis: Number(payload.modelPerformance?.opponentAnalysis || 0),
    },
    analysisVisibility: {
      decisionRecommendations: payload.analysisVisibility?.decisionRecommendations !== false,
      opponentAnalysis: Boolean(payload.analysisVisibility?.opponentAnalysis),
    },
    modelActivity: {
      decision: [0, 1, 2, 3].map((seat) => normalizeActivityState(payload.modelActivity?.decision?.[seat])),
      opponentAnalysis: normalizeActivityState(payload.modelActivity?.opponentAnalysis),
      errors: {
        decision: [0, 1, 2, 3].map((seat) => payload.modelActivity?.errors?.decision?.[seat] || null),
        opponentAnalysis: payload.modelActivity?.errors?.opponentAnalysis || null,
      },
    },
    modelRuntime: {
      decision: normalizeRuntimeState(payload.modelRuntime?.decision),
      opponentAnalysis: normalizeRuntimeState(payload.modelRuntime?.opponentAnalysis),
    },
    autoAnalysis: {
      status: String(payload.autoAnalysis?.status || 'idle'),
      completed: Number(payload.autoAnalysis?.completed || 0),
      total: Number(payload.autoAnalysis?.total || 0),
      cached: Number(payload.autoAnalysis?.cached || 0),
      analyzed: Number(payload.autoAnalysis?.analyzed || 0),
      failed: Number(payload.autoAnalysis?.failed || 0),
      currentNodeId: payload.autoAnalysis?.currentNodeId || null,
      currentModel: payload.autoAnalysis?.currentModel || null,
      message: String(payload.autoAnalysis?.message || ''),
      timeline: String(payload.autoAnalysis?.timeline || ''),
      timelineReady: Number(payload.autoAnalysis?.timelineReady || 0),
    },
  }
}

function createSessionStore(environmentGateway) {
  let snapshot = createInitialSnapshot()

  function cloneSnapshot() {
    return { ...snapshot }
  }

  async function syncFromEnvironment(methodName, ...args) {
    if (!environmentGateway || typeof environmentGateway[methodName] !== 'function') {
      return cloneSnapshot()
    }

    const response = await environmentGateway[methodName](...args)
    snapshot = normalizeSnapshot(response?.state || {})
    return cloneSnapshot()
  }

  return {
    async getSnapshot() {
      return syncFromEnvironment('getStatus')
    },
    async createGame() {
      return syncFromEnvironment('createGame')
    },
    async setMode(mode) {
      return syncFromEnvironment('setMode', mode)
    },
    async requestSeatSwitch(seat) {
      return syncFromEnvironment('requestSeatSwitch', seat)
    },
    async toggleVisibleHands() {
      return syncFromEnvironment('toggleVisibleHands')
    },
  }
}

module.exports = { createSessionStore, normalizeRuntimeState, normalizeSnapshot }
