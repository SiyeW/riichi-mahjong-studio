import assert from 'node:assert/strict'
import test from 'node:test'
import type { GameView } from './contracts/game.ts'
import { ref } from 'vue'
import {
  useDecisionActionPresentation,
  useDecisionEntryPresentation,
} from './useDecisionPresentation.ts'
import type { GameAction } from './contracts/game.ts'
import type { DecisionMetricDefinition } from './contracts/engines.ts'

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
  } as unknown as GameView
  const showTrainingRecommendations = ref(true)
  const entry = useDecisionEntryPresentation({
    gameView,
    t: (key) => key,
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
  assert.equal(entry.formatDecisionMetric(1234, entry.decisionMetricDefinitions.value[0]), '1234')
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

test('decision metric formatters are reused across rows within the finite precision domain', (t) => {
  const NumberFormat = Intl.NumberFormat
  let constructions = 0
  t.mock.method(Intl, 'NumberFormat', function (locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
    constructions++
    return new NumberFormat(locales, options)
  })
  const { entry } = createFixture()
  for (const fractionDigits of [undefined, ...Array.from({ length: 13 }, (_, index) => index)]) {
    const metric: DecisionMetricDefinition = { id: 'value', title: 'Value', format: 'number', preferredDirection: 'higher', fractionDigits }
    const expected = new NumberFormat('en-US', fractionDigits === undefined
      ? { useGrouping: false, maximumSignificantDigits: 15 }
      : { useGrouping: false, minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(12345.125)
    for (let row = 0; row < 20; row++) {
      assert.equal(entry.formatDecisionMetric(12345.125, { ...metric, id: String(row) }), expected)
    }
  }
  assert.equal(constructions, 14)
  const percentage: DecisionMetricDefinition = { id: 'p', title: 'Probability', format: 'percentage', preferredDirection: 'higher', fractionDigits: 2 }
  assert.equal(entry.formatDecisionMetric(0.12345, percentage), '12.35%')
  for (const fractionDigits of [-1, 13, 1.5, Number.NaN]) {
    assert.equal(entry.formatDecisionMetric(12345.125, { ...percentage, format: 'points', fractionDigits }), '12345.125')
  }
  assert.equal(entry.formatDecisionMetric(null, percentage), '—')
  assert.equal(entry.formatDecisionMetric(Number.NaN, percentage), '—')
  assert.equal(constructions, 14, 'metric ids, invalid precision and unavailable values do not grow the cache')
})
