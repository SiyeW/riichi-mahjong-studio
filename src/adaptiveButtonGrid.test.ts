import assert from 'node:assert/strict'
import test from 'node:test'
import { adaptiveGridColumns, requiredAdaptiveGridWidth } from './adaptiveButtonGrid.ts'

test('seat buttons stay in four columns until their rendered widths no longer fit', () => {
  const widths = [42, 36, 48, 44]
  assert.equal(requiredAdaptiveGridWidth(widths, 4, 4), 182)
  assert.equal(adaptiveGridColumns(182, widths, 4, { columns: [4, 2, 1] }), 4)
  assert.equal(adaptiveGridColumns(181, widths, 4, { columns: [4, 2, 1] }), 2)
})

test('two seat columns account for the widest button in each visual column', () => {
  const widths = [42, 36, 48, 44]
  assert.equal(requiredAdaptiveGridWidth(widths, 2, 4), 96)
  assert.equal(adaptiveGridColumns(96, widths, 4, { columns: [4, 2, 1] }), 2)
  assert.equal(adaptiveGridColumns(95, widths, 4, { columns: [4, 2, 1] }), 1)
})

test('an incomplete tree-action row measures its spanning final button independently', () => {
  const widths = [110, 82, 64]
  const options = { columns: [3, 2, 1], spanLastWhenIncomplete: true }
  assert.equal(requiredAdaptiveGridWidth(widths, 3, 6, true), 268)
  assert.equal(requiredAdaptiveGridWidth(widths, 2, 6, true), 198)
  assert.equal(adaptiveGridColumns(220, widths, 6, options), 2)
  assert.equal(adaptiveGridColumns(190, widths, 6, options), 1)
})
