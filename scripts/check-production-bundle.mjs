import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..', 'dist')
await fs.access(path.join(root, 'index.html'))
const files = await fs.readdir(root, { recursive: true })
for (const file of files.filter(file => /\.(?:js|css|html)$/.test(file))) {
  const content = await fs.readFile(path.join(root, file), 'utf8')
  for (const marker of ['perceptual-color-debugger', 'setupRmsAnalysisTest']) {
    assert.equal(content.includes(marker), false, `Development UI leaked into ${file}: ${marker}`)
  }
}
console.log('Production bundle excludes development calibration UI and renderer test controls.')
