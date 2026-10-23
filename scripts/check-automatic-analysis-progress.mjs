import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rms-auto-progress-'))
let server, browser
try {
  server = await createServer({ root, cacheDir: path.join(temporary, 'vite'),
    optimizeDeps: { noDiscovery: true, include: ['vue'] }, server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  for (const deviceScaleFactor of [.75, 1, 1.25, 2]) {
    const page = await browser.newPage({ deviceScaleFactor })
    await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/automatic-analysis-progress.html')
    await page.waitForFunction(() => window.automaticProgressFixture)
    await page.evaluate(() => window.automaticProgressFixture.settle())
    const initial = await page.evaluate(() => window.automaticProgressFixture.snapshot())
    assert.equal(initial.label, '242 / 534')
    assert.equal(initial.alpha[0], 0)
    assert.equal(initial.alpha.at(-1), 255, 'timeline preserves positional completion rather than a guessed left-to-right fill')
    const completed = await page.evaluate(() => window.automaticProgressFixture.progress('O'.repeat(534), 'completed'))
    assert.equal(completed.label, '534 / 534')
    assert.ok(completed.alpha.every(alpha => alpha === 255), 'background completion paints every slot without current-round analysis events')
    const rebound = await page.evaluate(() => window.automaticProgressFixture.replaceCanvas())
    assert.equal(rebound.replaced, true)
    assert.equal(rebound.oldConnected, false)
    assert.ok(rebound.alpha.every(alpha => alpha === 255), 'replacement canvas must repaint even when the timeline did not change')
    const resized = await page.evaluate(() => window.automaticProgressFixture.resize(213))
    assert.equal(resized.width, resized.expectedWidth, 'replacement canvas owns subsequent size observation')
    assert.ok(resized.alpha.every(alpha => alpha === 255))
    const empty = await page.evaluate(() => window.automaticProgressFixture.unloaded())
    assert.equal(empty.percent, 0)
    assert.ok(empty.alpha.every(alpha => alpha === 0), 'record retirement clears retained timeline paint')
    await page.evaluate(() => window.automaticProgressFixture.dispose())
    await page.close()
  }
  console.log('Automatic analysis progress: DPR .75/1/1.25/2, remote-round updates, complete pixels, canvas replacement, resize and record retirement passed.')
} finally {
  try { await browser?.close() } finally {
    try { await server?.close() } finally { await fs.rm(temporary, { recursive: true, force: true }) }
  }
}
