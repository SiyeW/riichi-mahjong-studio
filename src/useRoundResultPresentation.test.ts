import assert from 'node:assert/strict'
import test from 'node:test'
import { useRoundResultPresentation } from './useRoundResultPresentation.ts'

function createPresentation(resultInfo: Record<string, unknown>, dealer = 0) {
  const gameView = {
    table: {
      dealer,
      doraIndicators: ['1m'],
      riichiAccepted: [false, false, false, false],
      melds: [[], [], [], []],
      resultInfo,
    },
  } as unknown as TrainerGameView
  const status = { controlledSeat: 1 } as TrainerStatusSnapshot
  return useRoundResultPresentation({
    gameView,
    status,
    t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
    relativeSeatLabel: (seat) => `seat-${seat}`,
  })
}

test('round result presentation scores 4 han 30 fu without kiriage mangan', () => {
  const nonDealerRon = createPresentation({ actor: 1, target: 2, han: 4, fu: 30 })
  const nonDealerTsumo = createPresentation({ actor: 1, target: 1, han: 4, fu: 30 })
  const dealerRon = createPresentation({ actor: 0, target: 2, han: 4, fu: 30 })
  const dealerTsumo = createPresentation({ actor: 0, target: 0, han: 4, fu: 30 })

  assert.equal(nonDealerRon.resultPointsLabel.value, '7700')
  assert.equal(nonDealerTsumo.resultPointsLabel.value, '7900')
  assert.equal(dealerRon.resultPointsLabel.value, '11600')
  assert.equal(dealerTsumo.resultPointsLabel.value, '11700')
  assert.equal(nonDealerRon.resultHandLabel.value, '')
})

test('round result presentation also leaves 3 han 60 fu below mangan', () => {
  const ron = createPresentation({ actor: 1, target: 2, han: 3, fu: 60 })
  const tsumo = createPresentation({ actor: 1, target: 1, han: 3, fu: 60 })

  assert.equal(ron.resultPointsLabel.value, '7700')
  assert.equal(tsumo.resultPointsLabel.value, '7900')
  assert.equal(ron.resultHandLabel.value, '')
})

test('round result presentation keeps multi-yakuman labels and riichi ura slots', () => {
  const presentation = createPresentation({
    actor: 1,
    target: 1,
    han: 26,
    fu: 0,
    uraMarkers: ['2m'],
    yakuDetails: [{ name: 'Dai Suushii', han: 26, isYakuman: true }],
  })
  assert.equal(
    presentation.formatResultYakuValue(presentation.resultYakuItems.value[0]),
    'result.multipleYakuman:{"value":2}',
  )
  assert.deepEqual(presentation.resultUraSlots.value, ['2m', '?', '?', '?', '?'])
})

test('round result score cards retain the controlled-seat-relative order', () => {
  const presentation = createPresentation({
    scores: [24000, 25000, 26000, 25000],
    deltas: [-1000, 0, 1000, 0],
    ranks: [4, 2, 1, 3],
  })
  assert.deepEqual(
    presentation.resultScoreLayout.value.map(({ position, seat, label }) => ({ position, seat, label })),
    [
      { position: 'toimen', seat: 3, label: 'seat-3' },
      { position: 'kamicha', seat: 0, label: 'seat-0' },
      { position: 'shimocha', seat: 2, label: 'seat-2' },
      { position: 'self', seat: 1, label: 'seat-1' },
    ],
  )
})
