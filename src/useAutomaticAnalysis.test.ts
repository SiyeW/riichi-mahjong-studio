import assert from 'node:assert/strict'
import test from 'node:test'
import { autoAnalysisLineColor } from './useAutomaticAnalysis.ts'

test('automatic-analysis timeline colors distinguish active and completed work', () => {
  assert.equal(autoAnalysisLineColor('r'), 'rgb(143 121 82)')
  assert.equal(autoAnalysisLineColor('s'), 'rgb(143 121 82)')
  assert.equal(autoAnalysisLineColor('M'), 'rgb(77 102 107)')
  assert.equal(autoAnalysisLineColor('O'), 'rgb(77 102 107)')
  assert.equal(autoAnalysisLineColor('.'), null)
})
