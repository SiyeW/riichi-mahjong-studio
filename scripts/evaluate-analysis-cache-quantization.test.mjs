import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluate, quantizeProbability } from './evaluate-analysis-cache-quantization.mjs'

function record(probabilities) {
  return {
    game: {
      nodes: {
        n1: {
          opponentAnalysisCache: {
            model: {
              outputs: {
                'opponent-concealed-tile-count': {
                  players: [{
                    seat: 1,
                    tiles: {
                      '1m': {
                        distribution: probabilities.map((probability, value) => ({ value, probability })),
                      },
                    },
                  }],
                },
              },
            },
          },
        },
      },
    },
  }
}

test('UInt16 simulation preserves exact zero but exposes tiny-probability distortion', () => {
  assert.equal(quantizeProbability(0), 0)
  assert.ok(quantizeProbability(1e-7) > 0)
  const result = evaluate(record([0, 1e-7, 0.2, 0.7999999]))
  assert.equal(result.checks.absoluteImpossiblePreserved, true)
  assert.equal(result.checks.maxRelativeProbabilityErrorBelowFivePercent, false)
  assert.equal(result.recommendation, 'keep-float64')
})

test('well-separated ordinary probabilities can pass the UInt16 evaluation', () => {
  const result = evaluate(record([0.1, 0.2, 0.3, 0.4]))
  assert.equal(result.checks.noTopRankingTiesIntroduced, true)
  assert.equal(result.checks.maxExpectedValueErrorBelowOneTenThousandth, true)
})
