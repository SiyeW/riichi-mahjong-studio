import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium, _electron as electron } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-motion-check-'))
const evidence = path.join(root, '.mjai-runtime', 'motion-blur-trial')
fs.mkdirSync(evidence, { recursive: true })
let server, browser, desktop
const results = []
const apiPath = '/scripts/visual-tests/discard-motion/preview.ts'
async function invoke(page, method, argument) {
  return page.evaluate(async ({ method, argument, apiPath }) => {
    const preview = await import(apiPath)
    return preview[method](argument)
  }, { method, argument, apiPath })
}
async function pixelDifference(page, sweep = null) {
  const a = await page.locator('[data-pane="plain"]').screenshot()
  const b = await page.locator('[data-pane="blur"]').screenshot()
  return page.evaluate(async ({ a, b, sweep }) => {
    const load = source => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = source })
    const images = await Promise.all([load(a), load(b)])
    const arrays = images.map(image => {
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
      return context.getImageData(0, 0, canvas.width, canvas.height).data
    })
    if (arrays[0].length !== arrays[1].length) throw Error('Unequal comparison surfaces')
    const stage = document.querySelector('[data-pane="blur"]')
    const stageStyle = getComputedStyle(stage)
    const background = stageStyle.backgroundColor.match(/[\d.]+/g).slice(0, 3).map(Number).reduce((sum, value) => sum + value, 0)
    let changed = 0, absoluteError = 0, massA = 0, massB = 0
    for (let i = 0; i < arrays[0].length; i += 4) {
      const error = Math.max(...[0, 1, 2].map(channel => Math.abs(arrays[0][i + channel] - arrays[1][i + channel])))
      if (error > 2) changed++
      absoluteError += error
      massA += Math.max(0, arrays[0][i] + arrays[0][i + 1] + arrays[0][i + 2] - background)
      massB += Math.max(0, arrays[1][i] + arrays[1][i + 1] + arrays[1][i + 2] - background)
    }
    let minimumSweepSignal = Infinity
    if (sweep?.enabled) {
      const { geometry, progress, previousProgress } = sweep
      const rect = stage.getBoundingClientRect()
      const scaleX = images[1].naturalWidth / rect.width, scaleY = images[1].naturalHeight / rect.height
      const steps = Math.max(1, Math.ceil(sweep.blurLength * 2))
      for (let index = 0; index <= steps; index++) {
        const position = previousProgress + (progress - previousProgress) * index / steps
        const x = Math.floor((parseFloat(stageStyle.borderLeftWidth) + geometry.startX + geometry.dx * position) * scaleX)
        const y = Math.floor((parseFloat(stageStyle.borderTopWidth) + geometry.startY + geometry.dy * position) * scaleY)
        const offset = (y * images[1].naturalWidth + x) * 4
        const signal = arrays[1][offset] + arrays[1][offset + 1] + arrays[1][offset + 2] - background
        minimumSweepSignal = Math.min(minimumSweepSignal, signal)
      }
    }
    return { changed, mean: absoluteError / (arrays[0].length / 4), massRatio: massB / massA, minimumSweepSignal }
  }, { a: `data:image/png;base64,${a.toString('base64')}`, b: `data:image/png;base64,${b.toString('base64')}`, sweep })
}
async function check(page, url, label) {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 950 })
  await page.goto(url)
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  const different = []
  for (const seat of [0, 1, 2, 3]) for (const reverse of [false, true]) for (const diagonal of [false, true]) {
    await invoke(page, 'configure', { seat, reverse, diagonal, autoExposure: true, every: 3, scale: 1.5, blur: true, reveal: true })
    const sample = await invoke(page, 'seek', 22)
    const styles = await page.locator('.stage').evaluateAll(stages => stages.map(stage => ({
      sprite: stage.querySelector('.sprite').style.transform,
      artwork: stage.querySelector('.artwork').style.transform,
      back: stage.querySelector('.back').style.opacity,
      image: (() => { const rect = stage.querySelector('.face').getBoundingClientRect(); return [rect.width, rect.height] })(),
    })))
    assert.deepEqual(styles[0], styles[1], 'both comparisons have identical pose, position and face/back handoff')
    const pixels = await pixelDifference(page, sample)
    assert.ok(pixels.changed > 100, `${label}: filter must change rendered pixels, not merely pass CSS.supports`)
    assert.ok(pixels.massRatio > 0.8 && pixels.massRatio < 1.2, `${label}: blur must not hide or substantially clip the tile`)
    assert.ok(pixels.minimumSweepSignal > 3, `${label}: the swept centerline must not contain a background-only hole: ${JSON.stringify(pixels)}`)
    assert.equal(sample.exposure, 1000 * 3 / 165)
    different.push(pixels.changed)
    await invoke(page, 'seek', 110)
    const endpoint = await pixelDifference(page)
    assert.ok(endpoint.changed < 8, `${label}: endpoint returns to the same sharp image: ${JSON.stringify(endpoint)}`)
  }
  for (const scale of [0.7, 1, 2.5]) {
    await invoke(page, 'configure', { seat: 3, reverse: false, scale, exposure: 12, reveal: false })
    const result = await invoke(page, 'seek', 18)
    assert.ok(result.geometry.width > 10 && result.geometry.distance >= 0)
    assert.ok(Math.abs(result.blurLength - result.geometry.distance * Math.abs(result.progress - result.previousProgress)) < 1e-8)
    assert.equal(result.coverageSupported, true)
    const pixels = await pixelDifference(page, result)
    assert.ok(pixels.changed > 30 && pixels.massRatio > 0.8 && pixels.massRatio < 1.2)
    assert.ok(pixels.minimumSweepSignal > 3, `${label}: zoom preserves continuous centerline coverage`)
  }
  await invoke(page, 'configure', { autoExposure: false, exposure: 110, scale: 1.5, reveal: false })
  const wholeSweep = await invoke(page, 'seek', 109.9)
  const wholePixels = await pixelDifference(page, wholeSweep)
  assert.ok(wholePixels.minimumSweepSignal > 3 && wholePixels.massRatio > 0.8, 'even the whole flight is covered without hidden truncation')
  await invoke(page, 'configure', { autoExposure: true, loop: false })
  await page.evaluate(async apiPath => {
    const preview = await import(apiPath)
    const originalRequest = requestAnimationFrame, originalCancel = cancelAnimationFrame
    const queue = []
    let id = 0
    window.requestAnimationFrame = callback => { queue.push(callback); return ++id }
    window.cancelAnimationFrame = () => {}
    try {
      const start = performance.now()
      preview.play()
      queue.shift()(start + 200)
      if (document.querySelector('[data-pane="blur"] .direction').style.filter === 'none') throw Error('The landing interval was discarded after a missed flight')
      const landingCleanup = queue.shift()
      landingCleanup(start + 206)
      if (document.querySelector('[data-pane="blur"] .direction').style.filter !== 'none') throw Error('Landing did not return to a sharp static tile')
      preview.play()
      const stale = queue.shift()
      preview.play()
      stale(performance.now() + 50)
      if (!preview.seek(20).pendingFrame) throw Error('A stale callback cleared the replacement frame owner')
    } finally { preview.stop(); window.requestAnimationFrame = originalRequest; window.cancelAnimationFrame = originalCancel }
  }, apiPath)
  await page.setViewportSize({ width: 680, height: 800 })
  await invoke(page, 'configure', { scale: 2.5 })
  assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth), 'controls fit narrow viewports')
  await page.setViewportSize({ width: 1440, height: 950 })
  await invoke(page, 'configure', { seat: 3, scale: 1.5, reverse: false, reveal: false, autoExposure: true, every: 2 })
  await invoke(page, 'seek', 20)
  await page.screenshot({ path: path.join(evidence, `${label}.png`) })
  await invoke(page, 'configure', { blur: false })
  assert.ok((await pixelDifference(page)).changed < 8, 'switching off restores unfiltered drawing')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reduced = await invoke(page, 'seek', 22)
  await invoke(page, 'play')
  assert.equal(reduced.enabled, false)
  assert.equal(reduced.progress, 1)
  assert.equal((await invoke(page, 'seek', 22)).pendingFrame, false, 'reduced motion schedules no animation')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await invoke(page, 'configure', { reduced: true, blur: true })
  await invoke(page, 'play')
  const manualReduced = await invoke(page, 'seek', 22)
  assert.equal(manualReduced.progress, 1)
  assert.equal(manualReduced.pendingFrame, false)
  assert.equal(manualReduced.enabled, false, 'manual reduced-motion preference also wins over the effect')
  await invoke(page, 'configure', { reduced: false })
  await invoke(page, 'configure', { blur: true, loop: true })
  for (let i = 0; i < 12; i++) { await invoke(page, 'play'); await invoke(page, 'stop') }
  await invoke(page, 'dispose')
  await invoke(page, 'play')
  assert.equal((await invoke(page, 'seek', 50)).pendingFrame, false, 'disposed/replaced runs cannot schedule late frames')
  assert.deepEqual(errors, [])
  await page.goto(`${url}?noFilter=1`)
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  const fallback = await invoke(page, 'seek', 25)
  assert.equal(fallback.capable, false)
  assert.equal(fallback.enabled, false)
  assert.equal(fallback.samples, 0, 'unsupported effects do not allocate an unused filter graph')
  assert.ok((await pixelDifference(page)).changed < 8, 'unsupported filter falls back without removing the tile')
  await page.addInitScript(() => {
    const original = CSS.supports.bind(CSS)
    CSS.supports = (...args) => args[0] === 'filter' ? false : original(...args)
  })
  await page.goto(url)
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  assert.equal((await invoke(page, 'seek', 25)).enabled, false, 'real capability rejection also selects the sharp fallback')
  assert.ok((await pixelDifference(page)).changed < 8)
  results.push({ label, filteredPixelChanges: different, reducedMotion: true, fallback: true, lifecycle: true })
}
try {
  server = await createServer({ root, mode: 'ui-test', cacheDir: path.join(temporary, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  const url = `${server.resolvedUrls.local[0]}scripts/visual-tests/discard-motion/index.html`
  for (const software of [false, true]) {
    browser = await chromium.launch({ headless: true, args: software ? ['--disable-gpu'] : [] })
    for (const density of [1, 1.25, 2]) {
      const context = await browser.newContext({ deviceScaleFactor: density })
      try { await check(await context.newPage(), url, `chromium-${software ? 'software' : 'default'}-dpr${density}`) }
      finally { await context.close() }
    }
    await browser.close(); browser = null
  }
  desktop = await electron.launch({ args: [path.join(root, 'scripts', 'electron-ui-test-main.cjs')],
    env: { ...process.env, RMS_UI_TEST_URL: url, RMS_UI_TEST_DATA_DIR: path.join(temporary, 'electron-profile') } })
  const versions = await desktop.evaluate(() => process.versions)
  await check(await desktop.firstWindow(), url, 'electron')
  await desktop.close(); desktop = null
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify({ results, electron: versions,
    note: 'Pixel/behavior compatibility only. Headless/nonfocusable samples do not establish foreground FPS or smoothness.' }, null, 2))
  console.log(JSON.stringify({ results, electron: versions.electron, chromium: versions.chrome }))
} finally {
  try { await browser?.close(); await desktop?.close() }
  finally { try { await server?.close() } finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } }
}
