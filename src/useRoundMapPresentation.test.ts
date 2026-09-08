import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'

import { useRoundMapPresentation } from './useRoundMapPresentation.ts'

function round(
  id: string,
  roundIndex: number,
  childRoundIds: string[],
  mainNextRoundId: string | null,
): TrainerRoundSummary {
  return {
    id,
    parentRoundId: null,
    childRoundIds,
    mainNextRoundId,
    depth: roundIndex,
    roundIndex,
    bakaze: 'E',
    kyoku: roundIndex + 1,
    honba: 0,
    scores: [25000, 25000, 25000, 25000],
    isCurrent: id === 'main-next',
  }
}

test('round map lays out a main path and side continuation only while open', () => {
  const focusEvents: string[] = []
  const presentation = useRoundMapPresentation({
    roundSummaryList: ref([
      round('root', 0, ['main-next', 'side-next'], 'main-next'),
      round('main-next', 1, [], null),
      round('side-next', 1, [], null),
    ]),
    activeRoundRootId: ref('main-next'),
    status: { controlledSeat: 0 } as TrainerStatusSnapshot,
    uiScale: ref(1),
    t: (key) => key,
    localizedResultTitle: () => '',
    relativeSeatLabel: (seat) => String(seat),
    roundWindLabel: (wind) => wind,
    focusRoundMap: () => focusEvents.push('focus'),
  })

  assert.equal(presentation.roundMapOverlayOpen.value, false)
  assert.equal(presentation.roundMapDots.value.length, 0)

  presentation.openRoundMapOverlay()

  assert.equal(presentation.roundMapOverlayOpen.value, true)
  assert.deepEqual(focusEvents, ['focus'])
  assert.equal(presentation.roundMapDots.value.length, 3)
  assert.equal(presentation.roundMapEdges.value.length, 2)
  assert.equal(
    presentation.roundMapDots.value.find((dot) => dot.id === 'main-next')?.isCurrent,
    true,
  )
  assert.equal(
    presentation.roundMapDots.value.find((dot) => dot.id === 'side-next')!.x
      > presentation.roundMapDots.value.find((dot) => dot.id === 'main-next')!.x,
    true,
  )

  presentation.closeRoundMapOverlay()
  assert.equal(presentation.roundMapOverlayOpen.value, false)
  assert.equal(presentation.roundMapDots.value.length, 0)
})
