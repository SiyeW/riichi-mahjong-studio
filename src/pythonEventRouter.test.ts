import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'

import { createPythonEventRouter, type PythonEventRouterOptions } from './pythonEventRouter.ts'
import type { GameView } from './contracts/game.ts'
import type { PythonEvent, StudioStatus } from './contracts/runtime.ts'

function createHarness() {
  const calls = {
    lifecycle: [] as string[],
    opponent: [] as unknown[],
    cached: [] as Array<{ gameId: unknown; nodeId: unknown; analysis: unknown }>,
    prefetch: [] as Array<[string, string]>,
  }
  const status = {
    controlledSeat: 1,
    autoAnalysis: null,
  } as unknown as StudioStatus
  const gameView = {
    gameId: 'game-current',
    currentNodeId: 'node-current',
    analysis: null,
    opponentAnalysis: null,
    tree: {
      revision: 1,
      nodes: [],
      rounds: [],
    },
  } as unknown as GameView
  const options: PythonEventRouterOptions = {
    status,
    gameView,
    bootstrapError: ref(''),
    backendRecoveryNeeded: ref(false),
    backendHasCheckpoint: ref(false),
    clearingAnalysisCaches: ref(false),
    effectiveDecisionRecommendationsEnabled: ref(true),
    nodeMapById: ref(new Map()),
    t: (key) => key,
    applyStatus: () => {},
    applyGameView: () => {},
    clearRecordMetadata: () => {},
    resetForBackendLifecycle: () => calls.lifecycle.push('reset'),
    invalidateGameplayResponses: () => calls.lifecycle.push('gameplay'),
    invalidateNavigation: () => calls.lifecycle.push('navigation'),
    clearAutoAdvanceTimer: () => {},
    resetPlayPrefetch: () => {},
    acceptsOpponentEventEpoch: () => true,
    acceptsDecisionEventEpoch: () => true,
    markPlayPrefetchReady: (gameId, nodeId) => calls.prefetch.push([gameId, nodeId]),
    clearOpponentAnalysisWithoutMotion: () => {},
    fetchAnalysisOnce: async () => {},
    applyOpponentAnalysisEvent: (analysis) => calls.opponent.push(analysis),
    cacheDecisionAnalysis: (gameId, nodeId, analysis) => calls.cached.push({ gameId, nodeId, analysis }),
  }
  return { calls, gameView, options, status, route: createPythonEventRouter(options) }
}

test('service lifecycle events invalidate every request owner through one route', () => {
  const { calls, route } = createHarness()

  route({ type: 'service_ready' } as PythonEvent)

  assert.deepEqual(calls.lifecycle, ['reset', 'gameplay', 'navigation'])
})

test('model failure cannot clear an independent saved-result read', () => {
  const { route, options, gameView } = createHarness()
  let clears = 0
  options.clearOpponentAnalysisWithoutMotion = () => { clears += 1 }
  gameView.opponentAnalysis = { status: 'loading', context: { dataState: 'reading' } }
  route({ type: 'model_activity', model: 'opponent_analysis', activityState: 'error', error: 'bad weight' } as PythonEvent)
  assert.equal(clears, 0)
})

test('python event routing rejects stale game progress before mutating status', () => {
  const { route, status } = createHarness()

  route({
    type: 'auto_analysis_progress',
    gameId: 'game-stale',
    autoAnalysis: { running: true, completed: 1, total: 2 },
  } as unknown as PythonEvent)
  assert.equal(status.autoAnalysis, null)

  const progress = { running: true, completed: 2, total: 3 }
  route({ type: 'auto_analysis_progress', gameId: 'game-current', autoAnalysis: progress } as unknown as PythonEvent)
  assert.deepEqual(status.autoAnalysis, progress)
  assert.notEqual(status.autoAnalysis, progress)
})

test('record-wide automatic progress is independent of the visible node and analysis visit', () => {
  const { route, status, gameView, calls } = createHarness()
  const progress = { status: 'running', timeline: 'OMso', timelineReady: 2, completed: 2, total: 4,
    currentNodeId: 'another-round-node', currentModel: 'opponent', cached: 0, analyzed: 2, failed: 0, message: '' }
  route({ type: 'auto_analysis_progress', gameId: gameView.gameId, nodeId: 'another-round-node',
    viewToken: { sessionId: 'other-visit', nodeId: 'another-round-node', sequence: 1,
      intent: 1, gameId: gameView.gameId, seat: 1, mode: 'research', visibleHands: false,
      decisionEpoch: 0, opponentEpoch: 0 }, autoAnalysis: progress } as unknown as PythonEvent)
  assert.deepEqual(status.autoAnalysis, progress)
  assert.equal(gameView.currentNodeId, 'node-current')
  assert.equal(calls.opponent.length, 0)
})

test('opponent analysis must match the current game, node, seat, and cache epoch', () => {
  const { calls, options, route } = createHarness()
  const analysis = { context: { cacheEpoch: 7 } } as NonNullable<GameView['opponentAnalysis']>

  route({ type: 'opponent_analysis_ready', gameId: 'game-current', nodeId: 'node-old', seat: 1, opponentAnalysis: analysis } as PythonEvent)
  route({ type: 'opponent_analysis_ready', gameId: 'game-current', nodeId: 'node-current', seat: 2, opponentAnalysis: analysis } as PythonEvent)
  assert.equal(calls.opponent.length, 0)

  options.acceptsOpponentEventEpoch = (epoch) => epoch === 7
  route({ type: 'opponent_analysis_ready', gameId: 'game-current', nodeId: 'node-current', seat: 1, opponentAnalysis: analysis } as PythonEvent)
  assert.deepEqual(calls.opponent, [analysis])
})

test('decision analysis is cached for its event node without replacing another current node', () => {
  const { calls, gameView, route } = createHarness()
  const analysis = { seat: 1, discardEntries: [] } as unknown as NonNullable<GameView['analysis']>

  route({
    type: 'analysis_ready',
    gameId: 'game-current',
    nodeId: 'node-prefetched',
    analysis,
    cacheEpoch: 1,
  } as PythonEvent)

  assert.deepEqual(calls.cached, [{ gameId: 'game-current', nodeId: 'node-prefetched', analysis }])
  assert.equal(gameView.analysis, null)
})

test('decision analysis for the visible node is published immediately', () => {
  const { gameView, route } = createHarness()
  const analysis = { seat: 1, discardEntries: [] } as unknown as NonNullable<GameView['analysis']>

  route({
    type: 'analysis_ready',
    gameId: 'game-current',
    nodeId: 'node-current',
    analysis,
    cacheEpoch: 1,
  } as PythonEvent)

  assert.equal(gameView.analysis, analysis)
})
