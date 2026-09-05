import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, reactive, ref } from 'vue'
import { useAnalysisOutputs, type AnalysisRecord } from './useAnalysisOutputs.ts'
import { useAnalysisPanelData, type AnalysisPanelDataProps } from './useAnalysisPanelData.ts'

function fixture(analysis: AnalysisRecord | null = null) {
  const props = reactive<AnalysisPanelDataProps>({
    analysis,
    controlledSeat: 0,
    dealer: 0,
    shantenOpponents: [
      { key: 'kamicha', seat: 3, label: 'Upper', probabilities: [] },
      { key: 'toimen', seat: 2, label: 'Across', probabilities: [] },
      { key: 'shimocha', seat: 1, label: 'Lower', probabilities: [] },
    ],
  })
  const data = useAnalysisPanelData(props, {
    numberLocale: ref('en-US'),
    t: (key, params) => `${key}:${JSON.stringify(params || {})}`,
  })
  return { props, data }
}

test('empty analysis keeps predictions absent and preserves player order', () => {
  const { data } = fixture()
  assert.deepEqual(data.playerRows.value.map(player => player.seat), [3, 0, 1, 2])
  assert.ok(data.outcomeSegments.value.every(segment => segment.probability === 0))
  assert.ok(data.opponentCards.value.every(player => player.doraPrediction.scalarValue === null))
  assert.equal(data.maxAbsoluteDelta.value, 1000)
})

test('direct player totals and independently derived hover details stay separate', () => {
  const { data } = fixture({ outputs: {
    'kyoku-outcome': {
      outcomes: [{ type: 'tsumo', winner: 0, probability: 0.4 }, { type: 'draw', probability: 0.6 }],
      players: [{ seat: 0, winProbability: 0.9, dealInProbability: 0 }],
    },
    'opponent-dora-count': { players: [{ seat: 3, prediction: {
      expectedValue: 5,
      distribution: [{ value: 0, probability: 0.5 }, { value: '7+', probability: 0.5 }],
    } }] },
  } })
  const self = data.playerRows.value.find(player => player.seat === 0)!
  assert.equal(self.winProbability, 0.9)
  assert.deepEqual(self.targets.map(target => [target.seat, target.probability]), [[0, 1]])
  const dora = data.opponentCards.value[0].doraPrediction
  assert.equal(dora.scalarValue, 5)
  assert.equal(dora.distribution[1].value, '7+')
})

test('cached player indexes follow in-place updates, seat edits and output replacement', () => {
  const state = reactive({ analysis: { outputs: { example: { players: [
    { seat: 1, prediction: { expectedValue: 2 } },
    { seat: 2, prediction: { expectedValue: 3 } },
  ] } } } })
  const outputs = useAnalysisOutputs(() => state.analysis)
  const value = computed(() => outputs.seatPrediction('example', 1).scalarValue)
  assert.equal(value.value, 2)
  state.analysis.outputs.example.players[0].prediction.expectedValue = 4
  assert.equal(value.value, 4)
  state.analysis.outputs.example.players[0].seat = 3
  assert.equal(value.value, null)
  state.analysis.outputs.example.players.push({ seat: 1, prediction: { expectedValue: 7 } })
  assert.equal(value.value, 7)
  state.analysis.outputs = { example: { players: [] } }
  assert.equal(value.value, null)
})

test('optional red tiles appear and disappear with the supplied output', () => {
  const { props, data } = fixture()
  assert.equal(data.countSourceTiles.value.length, 34)
  props.analysis = { outputs: { 'wall-tile-count': {
    redTiles: { '5mr': { distribution: [{ value: 0, probability: 0 }, { value: 1, probability: 1 }] } },
  } } }
  assert.equal(data.countSourceTiles.value.length, 37)
  assert.deepEqual(data.countSegments('5mr', data.countSources.value[3]), [
    { value: 0, probability: 0 }, { value: 1, probability: 1 },
  ])
  props.analysis = null
  assert.equal(data.countSourceTiles.value.length, 34)
})

test('risk, score scale and seat order update after replacing analysis and viewpoint', () => {
  const { props, data } = fixture()
  assert.equal(data.riskScale.value, 0.2)
  props.analysis = { outputs: {
    'opponent-deal-in-probability': { players: [{ seat: 3, tiles: { '1m': 1, '2m': 0 } }] },
    'kyoku-score-delta': { players: [{ seat: 0, prediction: { expectedValue: -8000 } }] },
  } }
  assert.equal(data.riskScale.value, 1)
  assert.equal(data.riskProbability(3, '2m'), 0)
  assert.equal(data.maxAbsoluteDelta.value, 8000)
  props.controlledSeat = 2
  assert.deepEqual(data.playerRows.value.map(player => player.seat), [1, 2, 3, 0])
})
