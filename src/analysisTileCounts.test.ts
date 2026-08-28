import assert from 'node:assert/strict'
import test from 'node:test'
import { hasRedFiveCountPredictions } from './analysisTileCounts.ts'

test('red-five blocks stay hidden when the optional output is absent', () => {
  assert.equal(hasRedFiveCountPredictions({ tiles: {} }, [{ tiles: {} }]), false)
  assert.equal(hasRedFiveCountPredictions({ redTiles: {} }, []), false)
})

test('red-five blocks appear when either count output provides them', () => {
  assert.equal(hasRedFiveCountPredictions({ redTiles: { '5mr': {} } }, []), true)
  assert.equal(hasRedFiveCountPredictions({}, [{ redTiles: { '5pr': {} } }]), true)
})
