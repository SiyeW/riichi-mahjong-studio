import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium, _electron as electron } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rms-artwork-check-'))
let server, browser, electronApp
const errors = [], rounds = []
async function launch(options = {}) {
  let page
  if (process.env.RMS_UI_ELECTRON) {
    electronApp = await electron.launch({ args: [path.join(root, 'scripts/electron-ui-test-main.cjs')],
      env: { ...process.env, RMS_UI_TEST_URL: 'about:blank', RMS_UI_TEST_DATA_DIR: directory } })
    page = await electronApp.firstWindow()
  } else {
    browser = await chromium.launchPersistentContext(directory, { headless: true, viewport: { width: 1400, height: 1000 } })
    page = browser.pages()[0]
  }
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(({ deferDecode, rejectDecode }) => {
    window.artworkImages = []
    window.artworkDecodeResolvers = []
    window.artworkResources = { decodes: 0, databaseOpens: 0, bitmapExports: 0, canvases: 0 }
    const ImageConstructor = window.Image
    window.Image = function (...args) {
      const image = new ImageConstructor(...args)
      window.artworkImages.push(image)
      return image
    }
    window.Image.prototype = ImageConstructor.prototype
    const decode = HTMLImageElement.prototype.decode
    HTMLImageElement.prototype.decode = function () {
      window.artworkResources.decodes++
      if (rejectDecode && this.src.includes('/1m.svg')) return Promise.reject(new Error('Injected decode failure'))
      const decoded = decode.call(this)
      return deferDecode ? decoded.then(() => new Promise(resolve => window.artworkDecodeResolvers.push(resolve))) : decoded
    }
    // Native display must not require image export or disposable storage, even
    // when these APIs are unavailable. Count unexpected calls before rejecting.
    indexedDB.open = () => { window.artworkResources.databaseOpens++; throw new Error('Storage is not a display prerequisite') }
    URL.createObjectURL = () => { window.artworkResources.bitmapExports++; throw new Error('No encoded-image round trip') }
    window.OffscreenCanvas = function () { window.artworkResources.canvases++; throw new Error('No application raster scratch buffer') }
  }, options)
  await page.goto(server.resolvedUrls.local[0] + 'scripts/fixtures/tile-artwork.html')
  await page.waitForFunction(() => window.artworkTest)
  return page
}
async function close() {
  await browser?.close(); browser = null
  await electronApp?.close(); electronApp = null
}
async function ready(page, label) {
  await page.locator('#ready').filter({ hasText: 'true' }).waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.tileImg')].every(image => image.complete && image.naturalWidth > 0))
  const result = await page.evaluate(() => ({
    ...window.artworkResources, preloads: window.artworkImages.length,
    sources: [...document.querySelectorAll('.tileImg')].map(image => image.src),
    geometry: [...document.querySelectorAll('.tileImg')].map(image => [image.naturalWidth, image.naturalHeight]),
  }))
  assert.equal(result.preloads, 40, 'one bounded set of known artwork sources')
  assert.equal(result.decodes, 40, 'decode each source once, concurrently')
  assert.equal(result.databaseOpens, 0)
  assert.equal(result.bitmapExports, 0)
  assert.equal(result.canvases, 0)
  assert.ok(result.sources.every(source => source.split('?')[0].endsWith('.svg')))
  assert.ok(result.geometry.every(([width, height]) => width === 300 && height === 400))
  rounds.push({ label, ...result, sources: undefined, geometry: undefined })
  return result.sources
}
try {
  server = await createServer({ root, cacheDir: path.join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  let page = await launch()
  const sources = await ready(page, 'cold native source preparation')
  await page.evaluate(() => Promise.all(Array.from({ length: 5 }, () => window.artworkTest.artwork.prepareTileArtwork())))
  assert.deepEqual(await ready(page, 'repeated preparation reuses decoded sources'), sources)
  const originalWidth = await page.locator('.tileImg').first().evaluate(image => image.getBoundingClientRect().width)
  for (const scale of [.5, .75, 1.25, 1.5, 2]) {
    await page.evaluate(async scale => { window.artworkTest.uiScale.value = scale; await window.artworkTest.nextTick() }, scale)
  }
  const resizedWidth = await page.locator('.tileImg').first().evaluate(image => image.getBoundingClientRect().width)
  assert.ok(resizedWidth > originalWidth * 1.9, 'resize really changes displayed tile geometry')
  assert.deepEqual(await ready(page, 'continuous resize has no regeneration or source handoff'), sources)
  const client = await page.context().newCDPSession(page)
  if (electronApp) await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2))
  else await client.send('Emulation.setDeviceMetricsOverride', { width: 1800, height: 1200, deviceScaleFactor: 2, mobile: false })
  await page.waitForFunction(() => window.devicePixelRatio === 2)
  assert.deepEqual(await ready(page, 'DPI change uses native vector coverage'), sources)
  await client.detach()
  await page.evaluate(() => window.artworkTest.unmount())
  assert.equal(await page.evaluate(() => window.artworkImages.every(image => image.getAttribute('src') === '' && image.onload === null && image.onerror === null)), true)
  await close()
  page = await launch()
  await ready(page, 'process restart needs no persistent image cache')
  await close()
  page = await launch({ rejectDecode: true })
  await ready(page, 'one decode failure cannot hold the interface pending')
  await close()
  page = await launch({ deferDecode: true })
  await page.waitForFunction(() => window.artworkDecodeResolvers.length === 40)
  assert.equal(await page.evaluate(() => window.artworkTest.artwork.tileArtworkReady.value), false)
  await page.evaluate(async () => {
    window.artworkTest.unmount()
    window.artworkDecodeResolvers.forEach(resolve => resolve())
    await Promise.resolve(); await Promise.resolve()
  })
  assert.equal(await page.evaluate(() => window.artworkTest.artwork.tileArtworkReady.value), false)
  assert.equal(await page.locator('.tileImg').count(), 0)
  assert.equal(await page.evaluate(() => window.artworkImages.every(image => image.getAttribute('src') === '' && image.onload === null && image.onerror === null)), true)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'Native artwork readiness, reuse, resize, DPI, failures and disposal passed', rounds }))
} finally {
  try { await close() } finally {
    try { await server?.close() } finally {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
}
