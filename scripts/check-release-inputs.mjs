import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const projectRoot = path.resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const examplePath = path.join(projectRoot, 'examples', '示例牌谱.mjstudio')

assert.ok(fs.existsSync(examplePath), 'the public example record is missing')
const encoded = fs.readFileSync(examplePath)
const decoded = encoded[0] === 0x1f && encoded[1] === 0x8b ? zlib.gunzipSync(encoded) : encoded
const record = JSON.parse(decoded.toString('utf8'))
assert.equal(record.formatVersion, 3, 'the public example must use the current Studio record format')
assert.ok(Object.keys(record.game?.nodes || {}).length > 0, 'the public example has no game nodes')
assert.ok(
  Object.values(record.game?.nodes || {}).some((node) => Object.keys(node.analysisCache || {}).length),
  'the public example has no cached decision analysis',
)
assert.ok(
  Object.values(record.game?.nodes || {}).some((node) => Object.keys(node.opponentAnalysisCache || {}).length),
  'the public example has no cached opponent analysis',
)

const serialized = JSON.stringify(record)
for (const forbidden of ['Mortal', 'Akagi', 'New All', '凤桌', 'Users\\\\', 'Programs\\\\']) {
  assert.equal(serialized.includes(forbidden), false, `the public example contains private source text: ${forbidden}`)
}

const packagedExample = packageJson.build?.extraFiles?.find((entry) => (
  entry.from === 'examples/示例牌谱.mjstudio'
  && entry.to === 'records/示例牌谱.mjstudio'
))
assert.ok(packagedExample, 'the Windows package does not place the example in its default records folder')

console.log('Release inputs: public example record and package destination passed.')
