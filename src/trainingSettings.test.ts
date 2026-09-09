import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeTrainingMode } from './trainingSettings.ts'

test('training modes accept current values and migrate legacy names', () => {
  assert.equal(normalizeTrainingMode('no_review'), 'no_review')
  assert.equal(normalizeTrainingMode('preview_before_click'), 'preview_before_click')
  assert.equal(normalizeTrainingMode('threshold_review'), 'threshold_review')
  assert.equal(normalizeTrainingMode('always_review'), 'always_review')
  assert.equal(normalizeTrainingMode('free_play'), 'preview_before_click')
  assert.equal(normalizeTrainingMode('guided'), 'threshold_review')
  assert.equal(normalizeTrainingMode('strict'), 'always_review')
})

test('missing and unknown training modes use the established default', () => {
  assert.equal(normalizeTrainingMode(undefined), 'threshold_review')
  assert.equal(normalizeTrainingMode('future-mode'), 'threshold_review')
})
