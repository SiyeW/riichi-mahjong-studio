import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium, _electron as electron } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rms-artwork-check-'))
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false } })
let browser
let electronApp
const errors = []
const rounds = []
async function launch(options = {}) {
  const url = server.resolvedUrls.local[0] + 'scripts/fixtures/tile-artwork.html'
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
  await page.addInitScript(({ failStorage, failRaster, disposeEarly, busy }) => {
    window.artworkDraws = 0
    window.artworkUrls = new Set()
    window.artworkCanvases = []
    const Canvas = OffscreenCanvas
    window.OffscreenCanvas = class extends Canvas {
      constructor(width, height) { super(width, height); window.artworkCanvases.push(this) }
    }
    const draw = OffscreenCanvasRenderingContext2D.prototype.drawImage
    OffscreenCanvasRenderingContext2D.prototype.drawImage = function (...args) {
      window.artworkDraws++
      if (failRaster) throw new Error('Injected canvas failure')
      return draw.apply(this, args)
    }
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL
    URL.createObjectURL = function (blob) { const url = create.call(this, blob); window.artworkUrls.add(url); return url }
    URL.revokeObjectURL = function (url) { window.artworkUrls.delete(url); return revoke.call(this, url) }
    if (failStorage) indexedDB.open = () => { throw new Error('Injected disabled storage') }
    if (busy) window.artworkBusyTimer = setInterval(() => window.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 })), 16)
    if (disposeEarly) {
      const timer = setInterval(() => {
        if (window.artworkDraws) { clearInterval(timer); window.artworkTest.unmount() }
      }, 1)
    }
  }, options)
  await page.goto(url)
  await page.waitForFunction(() => window.artworkTest)
  return page
}
async function close() {
  await browser?.close(); browser = null
  await electronApp?.close(); electronApp = null
}
async function ready(page, label, expectedDraws) {
  await page.locator('#ready').filter({ hasText: 'true' }).waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.tileImg')].every(image => image.src.startsWith('blob:')))
  await page.waitForFunction(() => window.artworkUrls.size === 40)
  const result = await page.evaluate(() => ({ draws: window.artworkDraws, urls: window.artworkUrls.size,
    scratchBuffersReleased: window.artworkCanvases.every(canvas => canvas.width === 0 && canvas.height === 0),
    geometry: [...document.querySelectorAll('.tileImg')].map(image => ({ width: image.naturalWidth, height: image.naturalHeight })) }))
  assert.equal(result.draws, expectedDraws, label)
  assert.equal(result.urls, 40, 'one complete known-face generation')
  assert.equal(result.scratchBuffersReleased, true, 'finished generations release their shared scratch buffer')
  assert.ok(result.geometry.every(image => image.width * 4 === image.height * 3), 'original exact intrinsic aspect')
  rounds.push({ label, ...result, geometry: undefined })
}
async function damage(page, mutate) {
  await page.evaluate(async mutate => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('rms-tile-artwork', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    await new Promise((resolve, reject) => {
      const tx = db.transaction('faces', 'readwrite'), store = tx.objectStore('faces'), request = store.getAll()
      request.onsuccess = () => {
        const entry = request.result[0]
        if (mutate === 'missing') store.delete(entry.id)
        else { if (mutate === 'version') entry.version--
          if (mutate === 'source') entry.sourceHash = 'outdated'
          if (mutate === 'body') entry.blob = new Blob(['not png'], { type: 'image/png' })
          store.put(entry) }
      }
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, mutate)
}
try {
  await server.listen()
  let page = await launch()
  await ready(page, 'cold generation', 40)
  await close()
  page = await launch()
  await ready(page, 'process restart reuses persistent artwork', 0)
  for (const mutation of ['version', 'source', 'body', 'missing']) {
    await damage(page, mutation)
    await close()
    page = await launch()
    await ready(page, `${mutation} entry repaired independently`, 1)
  }
  await page.evaluate(() => { window.artworkTest.uiScale.value = 3 })
  await page.waitForFunction(() => window.artworkDraws === 41)
  await ready(page, 'larger supported demand replaces generation', 41)
  await page.waitForTimeout(250)
  assert.equal(await page.evaluate(() => window.artworkUrls.size), 40, 'retired generation URLs released')
  await page.evaluate(() => { window.artworkTest.uiScale.value = 1 })
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => window.artworkDraws), 41, 'shrinking reuses sufficient coverage')
  const client = await page.context().newCDPSession(page)
  if (electronApp) await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(3))
  else await client.send('Emulation.setDeviceMetricsOverride', { width: 1800, height: 1200, deviceScaleFactor: 3, mobile: false })
  try {
    await page.waitForFunction(() => window.devicePixelRatio === 3 && window.artworkDraws === 81)
  } catch (error) {
    console.error('DPI fixture state', await page.evaluate(() => ({ draws: window.artworkDraws,
      ratio: window.devicePixelRatio, screen: [screen.availWidth, screen.availHeight],
      window: [innerWidth, innerHeight], font: getComputedStyle(document.querySelector('.shell')).fontSize,
      cached: window.artworkTest.artwork.tileImageSrc('1m').startsWith('blob:') })))
    throw error
  }
  await ready(page, 'runtime DPI change expands physical coverage', 81)
  if (electronApp) await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  else await client.send('Emulation.clearDeviceMetricsOverride')
  await client.detach()
  await page.evaluate(() => { window.artworkTest.uiScale.value = 20 })
  await page.waitForFunction(() => [...document.querySelectorAll('.tileImg')].every(image => !image.src.startsWith('blob:')))
  assert.equal(await page.evaluate(() => window.artworkDraws), 81, 'over-budget demand keeps vectors, never blurry cached upscaling')
  await page.evaluate(() => window.artworkTest.unmount())
  await page.waitForFunction(() => window.artworkUrls.size === 0)
  await page.waitForFunction(() => window.artworkCanvases.every(canvas => canvas.width === 0 && canvas.height === 0))
  await close()
  page = await launch({ failStorage: true })
  await ready(page, 'unavailable storage remains optional', 40)
  await close()
  page = await launch({ failStorage: true, busy: true })
  await page.locator('#ready').filter({ hasText: 'true' }).waitFor()
  await page.waitForTimeout(350)
  assert.equal(await page.evaluate(() => window.artworkDraws), 0, 'active navigation defers cache generation without blocking readiness')
  await page.evaluate(() => clearInterval(window.artworkBusyTimer))
  await ready(page, 'preparation resumes after input settles', 40)
  await close()
  page = await launch({ failStorage: true, failRaster: true })
  await page.locator('#ready').filter({ hasText: 'true' }).waitFor()
  await page.waitForFunction(() => window.artworkDraws > 0)
  assert.ok(await page.locator('.tileImg').evaluateAll(images => images.every(image => !image.src.startsWith('blob:') && image.naturalWidth === 300)))
  await close()
  page = await launch({ failStorage: true, disposeEarly: true })
  await page.waitForFunction(() => document.querySelectorAll('.tileImg').length === 0)
  await page.waitForFunction(() => window.artworkUrls.size === 0)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'Tile artwork lifecycle, persistence, fallback and pixel coverage passed', rounds }))
} finally {
  await close()
  await server.close()
  // This is an explicitly created temp browser directory, never user data.
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
