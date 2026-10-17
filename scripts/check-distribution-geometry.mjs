import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rms-distribution-'))
let server, browser
const results = []
try {
  await fs.mkdir(path.join(root, '.mjai-runtime'), { recursive: true })
  server = await createServer({ root, cacheDir: path.join(temporary, 'vite'), optimizeDeps: { noDiscovery: true, include: ['vue'] }, server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  browser = await chromium.launch({ headless: true })
  for (const ratio of [.75, 1, 1.25, 1.5, 2]) {
    const page = await browser.newPage({ deviceScaleFactor: ratio, viewport: { width: 900, height: 700 } })
    await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/distribution-geometry.html')
    await page.waitForFunction(() => window.checkDistributionGeometry)
    for (const width of [80.3, 113.2, 181.6, 241.35]) for (const count of [8, 31, 54]) for (const labels of [false, true]) {
      const result = await page.evaluate(options => window.checkDistributionGeometry(options), { width, count, labels })
      assert.ok(Math.max(...result.bars.map(bar => bar.width)) - Math.min(...result.bars.map(bar => bar.width)) <= 1.000001)
      assert.ok(result.bars.every(bar => bar.allOpaque), 'gaps must not consume any bar pixel')
      assert.ok(result.gaps.every(gap => gap.width <= Math.max(1, Math.round(ratio)) + 1e-8 && gap.alphas.every(value => value === 209)))
      assert.equal(result.overflow, false, 'dense plots fit rather than creating scrollbars')
      assert.ok(Math.abs(result.cssWidth - result.bitmapWidth) < .04, 'bitmap pixels must not be stretched')
      assert.ok(Math.abs(result.originX - Math.round(result.originX)) < .04 && Math.abs(result.originY - Math.round(result.originY)) < .04, 'canvas origin must align to the physical grid')
      assert.ok(result.cells.every((cell, i) => Math.abs(cell.width - result.bars[i].width) < .04), 'hover geometry matches physical fill widths')
      assert.ok(result.cells.every((cell, i) => Math.abs(cell.left - result.bars[i].left) < .04), 'hover cells follow the same bar/gap allocation')
      results.push({ ratio, width, count, labels, barWidth: result.bars[0].width, overflow: result.overflow })
    }
    const motion = await page.evaluate(() => window.checkDistributionGeometry({ width: 240, count: 31, labels: false, animate: true }))
    assert.ok(motion.samples.some(item => item.scale > .3 && item.scale < .99), 'axis must have intermediate scale positions')
    assert.ok(motion.samples.every(item => item.guideRatio === null || Math.abs(item.guideRatio - .3 / item.scale) < .025), 'guide and ticks share the actual animated scale')
    for (const labels of [false, true]) {
      const resized = await page.evaluate(options => window.checkDistributionGeometry(options), { width: 241.35, count: 54, labels, resize: true })
      for (const item of resized.resizes) {
        assert.ok(Math.max(...item.widths) - Math.min(...item.widths) <= 1.000001, 'resizing balances physical widths')
        assert.ok(Math.abs(item.cssWidth - item.bitmapWidth) < .04, 'resize does not stretch bitmap')
        assert.ok(item.lastVisible, `all candidates fit in narrow layouts: ${JSON.stringify({ ratio, labels, item })}`)
      }
      const group = await page.evaluate(options => window.checkDistributionGeometry(options), { width: 317.37, count: labels ? 8 : 54, labels, resize: true, group: true })
      for (const widths of [group.groupWidths, ...group.resizes.map(item => item.groupWidths)]) {
        assert.equal(new Set(widths).size, 1, 'fractional origins never give the three opponents different width thresholds')
      }
    }
    if (ratio === 1.25) {
      await page.evaluate(async () => {
        await window.checkDistributionGeometry({ width: 240.35, count: 31, labels: false, keep: true })
        await window.checkDistributionGeometry({ width: 240.35, count: 8, labels: true, keep: true })
      })
      await page.locator('#fixture').screenshot({ path: path.join(root, '.mjai-runtime/distribution-axis-pixels.png') })
    }
    await page.close()
  }
  console.log(`Distribution physical pixels and axes passed: ${results.length} cases; DPR .75/1/1.25/1.5/2, balanced fills, reserved gaps, no overflow, shared group thresholds and animated scales.`)
  await fs.writeFile(path.join(root, '.mjai-runtime/distribution-geometry.json'), JSON.stringify(results, null, 2))
} finally {
  try {
    await browser?.close()
  } finally {
    try {
      await server?.close()
    } finally {
      await fs.rm(temporary, { recursive: true, force: true })
    }
  }
}
