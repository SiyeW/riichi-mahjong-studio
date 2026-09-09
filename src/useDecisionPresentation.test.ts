import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import {
  useDecisionActionPresentation,
  useDecisionEntryPresentation,
} from './useDecisionPresentation.ts'
import type { GameAction } from './contracts/game.ts'

function createFixture() {
  const gameView = {
    analysis: {
      bestAction: { type: 'dahai', pai: '5m', tsumogiri: true },
      discardEntries: [
        { candidateId: 'discard', pai: '5m', tsumogiri: true, value: 2, bar: 0.4 },
      ],
      specialEntries: [
        { candidateId: 'pass', type: 'none', variant: 'none', value: 1, bar: 0.2 },
      ],
      reactionEntries: [
        { candidateId: 'ron', type: 'hora', variant: 'ron', value: 3, bar: 0.8 },
      ],
      metricDefinitions: [{ id: 'score', format: 'points', preferredDirection: 'higher' }],
      primaryMetricId: 'score',
    },
  } as unknown as TrainerGameView
  const showTrainingRecommendations = ref(true)
  const entry = useDecisionEntryPresentation({
    gameView,
    t: (key) => key,
    normalizeTileFamily: (tile) => tile.replace(/r$/, ''),
    redFive: (tile) => `red:${tile}`,
    reactionTypeLabel: (type) => `reaction:${type}`,
  })
  const pass = { id: 'pass', candidateId: 'pass', type: 'none' } as GameAction
  const discard = {
    id: 'discard',
    candidateId: 'discard',
    type: 'dahai',
    pai: '5m',
    tsumogiri: true,
  } as GameAction
  const action = useDecisionActionPresentation({
    gameView,
    showTrainingRecommendations,
    t: (key) => key,
    normalizeTileFamily: (tile) => tile.replace(/r$/, ''),
    redFive: (tile) => `red:${tile}`,
    getSpecialActions: () => [pass],
    getDiscardActions: () => [discard],
    getSouthHandDisplay: () => ['1m', '5m'],
    hasRecommendationAnalysis: () => true,
    resolveSpecialEntry: entry.resolveSpecialEntry,
    resolveReactionEntry: entry.resolveReactionEntry,
    resolveDiscardEntry: entry.resolveDiscardEntry,
    analysisEntryIsBest: entry.analysisEntryIsBest,
    resolveAnalysisEntryBar: entry.resolveAnalysisEntryBar,
  })
  return { action, discard, entry, pass, showTrainingRecommendations }
}

test('decision entry presentation owns matching, ordering, and best-action identity', () => {
  const { entry, discard } = createFixture()
  const resolved = entry.resolveDiscardEntry(discard)

  assert.equal(resolved?.candidateId, 'discard')
  assert.equal(entry.analysisEntryIsBest(resolved), true)
  assert.deepEqual(entry.mergedAnalysisEntries.value.map((item) => item.candidateId), ['discard', 'pass'])
  assert.equal(entry.formatDecisionMetric(1234, entry.decisionMetricDefinitions.value[0]), '1,234')
})

test('decision action presentation owns quick actions and normalized table bars', () => {
  const { action, discard, pass, showTrainingRecommendations } = createFixture()

  assert.equal(action.findQuickPassAction(), pass)
  assert.equal(action.findQuickTsumogiriAction(), discard)
  assert.equal(action.isBestAction(discard), true)
  assert.deepEqual(action.barFillStyle(action.resolveDisplayedActionBar(discard)), {
    transform: 'scaleY(0.5)',
  })
  showTrainingRecommendations.value = false
  assert.equal(action.resolveDisplayedActionBar(discard), 0)
})
