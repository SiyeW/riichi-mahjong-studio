import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { decodeGameRecord } = require('../electron/main/state/game-record-codec')

const UINT16_MAX = 65535
const STEP = 1 / UINT16_MAX

function quantizeProbability(value) {
  if (value === 0) return 0
  return Math.max(1, Math.min(UINT16_MAX, Math.round(value * UINT16_MAX))) / UINT16_MAX
}

function collectEvaluation(record) {
  const probabilities = []
  const groups = []
  const distributions = []

  function addGroup(values, label) {
    if (values.length < 2 || values.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return
    probabilities.push(...values)
    groups.push({ label, values })
  }

  function visit(value, trail = []) {
    if (Array.isArray(value)) {
      if (value.length && value.every(item => item && typeof item === 'object'
        && Number.isFinite(item.probability) && item.probability >= 0 && item.probability <= 1)) {
        const values = value.map(item => item.probability)
        addGroup(values, trail.join('.'))
        if (value.every(item => Number.isFinite(item.value))) {
          distributions.push({ label: trail.join('.'), values: value.map(item => item.value), probabilities: values })
        }
      }
      value.forEach((child, index) => visit(child, [...trail, String(index)]))
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'tiles' && child && typeof child === 'object' && !Array.isArray(child)) {
        const tileValues = Object.values(child)
        if (tileValues.length && tileValues.every(item => Number.isFinite(item))) {
          addGroup(tileValues, [...trail, key].join('.'))
        }
      } else if ((key === 'probabilities' || key === 'distribution')
        && Array.isArray(child) && child.every(item => Number.isFinite(item))) {
        addGroup(child, [...trail, key].join('.'))
      } else if (key === 'probability' && Number.isFinite(child) && child >= 0 && child <= 1) {
        // Arrays of probability objects are collected as one ranking group above.
        if (!Array.isArray(value)) probabilities.push(child)
      }
      visit(child, [...trail, key])
    }
  }

  for (const node of Object.values(record?.game?.nodes || {})) {
    for (const result of Object.values(node?.analysisCache || {})) visit(result, ['decision'])
    for (const result of Object.values(node?.opponentAnalysisCache || {})) visit(result, ['opponent'])
  }
  return { probabilities, groups, distributions }
}

function evaluate(record) {
  const { probabilities, groups, distributions } = collectEvaluation(record)
  const positive = probabilities.filter(value => value > 0)
  const zeros = probabilities.length - positive.length
  const tiny = positive.filter(value => value < STEP)
  const relativeErrors = positive.map(value => Math.abs(quantizeProbability(value) - value) / value)
  let strictPairs = 0
  let collapsedPairs = 0
  let topTiesIntroduced = 0
  for (const { values } of groups) {
    const quantized = values.map(quantizeProbability)
    for (let left = 0; left < values.length; left += 1) {
      for (let right = left + 1; right < values.length; right += 1) {
        if (values[left] === values[right]) continue
        strictPairs += 1
        if (quantized[left] === quantized[right]) collapsedPairs += 1
      }
    }
    const maximum = Math.max(...values)
    if (values.filter(value => value === maximum).length === 1) {
      const quantizedMaximum = Math.max(...quantized)
      if (quantized.filter(value => value === quantizedMaximum).length > 1) topTiesIntroduced += 1
    }
  }
  const expectedErrors = distributions.map(({ values, probabilities: distribution }) => {
    const before = values.reduce((sum, value, index) => sum + value * distribution[index], 0)
    const after = values.reduce((sum, value, index) => sum + value * quantizeProbability(distribution[index]), 0)
    return Math.abs(after - before)
  })
  const max = values => values.reduce((largest, value) => Math.max(largest, value), 0)
  const sorted = relativeErrors.slice().sort((left, right) => left - right)
  const percentile = fraction => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] : 0
  const checks = {
    absoluteImpossiblePreserved: zeros > 0 && positive.every(value => quantizeProbability(value) > 0),
    noTopRankingTiesIntroduced: topTiesIntroduced === 0,
    strictRankingCollapseBelowOnePerTenThousand: strictPairs === 0 || collapsedPairs / strictPairs < 0.0001,
    maxExpectedValueErrorBelowOneTenThousandth: max(expectedErrors) < 0.0001,
    maxRelativeProbabilityErrorBelowFivePercent: max(relativeErrors) < 0.05,
  }
  return {
    recommendation: Object.values(checks).every(Boolean) ? 'adopt-uint16' : 'keep-float64',
    checks,
    sample: {
      probabilityValues: probabilities.length,
      exactZeros: zeros,
      positiveBelowOneStep: tiny.length,
      rankingGroups: groups.length,
      strictRankingPairs: strictPairs,
      collapsedStrictRankingPairs: collapsedPairs,
      topTiesIntroduced,
      expectedValueDistributions: distributions.length,
    },
    error: {
      uint16Step: STEP,
      medianRelativeProbability: percentile(0.5),
      p95RelativeProbability: percentile(0.95),
      maximumRelativeProbability: max(relativeErrors),
      maximumExpectedValue: max(expectedErrors),
    },
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const sourcePath = process.argv[2]
  if (!sourcePath) {
    console.error('Usage: node scripts/evaluate-analysis-cache-quantization.mjs <record.mjstudio>')
    process.exitCode = 2
  } else {
    const absolutePath = path.resolve(sourcePath)
    const record = decodeGameRecord(fs.readFileSync(absolutePath))
    console.log(JSON.stringify({ source: absolutePath, ...evaluate(record) }, null, 2))
  }
}

export { collectEvaluation, evaluate, quantizeProbability }
