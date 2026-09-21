import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import { gzipSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'

const require = createRequire(import.meta.url)
const { decodeGameRecord } = require('../electron/main/state/game-record-codec')
const { compactAnalysisCaches, expandAnalysisCaches } = require('../electron/main/state/analysis-cache-storage')

const sourcePath = process.argv[2]
if (!sourcePath) {
  console.error('Usage: node scripts/measure-record-storage.mjs <record.mjstudio>')
  process.exitCode = 2
} else {
  const absolutePath = path.resolve(sourcePath)
  const input = fs.readFileSync(absolutePath)
  const startedDecode = performance.now()
  const record = decodeGameRecord(input)
  const decodeMs = performance.now() - startedDecode

  const baselineJson = Buffer.from(JSON.stringify(record))
  const baselineGzip = gzipSync(baselineJson, { level: 6 })
  const startedCompact = performance.now()
  const compact = compactAnalysisCaches(record)
  const compactMs = performance.now() - startedCompact
  const compactJson = Buffer.from(JSON.stringify(compact))
  const startedGzip = performance.now()
  const compactGzip = gzipSync(compactJson, { level: 6 })
  const gzipMs = performance.now() - startedGzip
  const startedExpand = performance.now()
  const restored = expandAnalysisCaches(JSON.parse(compactJson.toString('utf8')))
  const expandMs = performance.now() - startedExpand

  const reduction = (before, after) => before === 0 ? 0 : (1 - after / before) * 100
  console.log(JSON.stringify({
    source: absolutePath,
    exactRoundTrip: isDeepStrictEqual(restored, record),
    bytes: {
      input: input.length,
      expandedJson: baselineJson.length,
      expandedGzip: baselineGzip.length,
      compactJson: compactJson.length,
      compactGzip: compactGzip.length,
      gzipReductionPercent: reduction(baselineGzip.length, compactGzip.length),
    },
    milliseconds: { decode: decodeMs, compact: compactMs, gzip: gzipMs, expand: expandMs },
  }, null, 2))
}
