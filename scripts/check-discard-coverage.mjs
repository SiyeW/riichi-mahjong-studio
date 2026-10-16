import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium, _electron as electron } from 'playwright'
import { spawnSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rms-coverage-check-'))
const evidence = path.join(root, '.mjai-runtime', 'discard-coverage')
fs.mkdirSync(evidence, { recursive: true })
let server, browser, desktop
const results = []
async function check(page, label, dense) {
  await page.setViewportSize({ width: 1000, height: 850 })
  await page.goto(`${server.resolvedUrls.local[0]}scripts/visual-tests/discard-motion/index.html`)
  await page.waitForFunction(() => document.body.dataset.ready === 'true')
  await page.evaluate(async () => {
    ;(await import('/scripts/visual-tests/discard-motion/preview.ts')).dispose()
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/src/components/TableRivers.css?direct'
    const loaded = new Promise(resolve => { css.onload = resolve }); document.head.append(css); await loaded
    document.body.innerHTML = ''
    document.body.style.cssText = 'background:#02191e;margin:0;overflow:hidden;--zoom:1.5'
    window.coverageApi = await import('/src/discardCoverage.ts')
  })
  const poses = dense ? [0, 1, 2, 3] : [3]
  for (const seat of poses) for (const riichi of [false, true]) for (const reverse of [false, true]) {
    const prepared = await page.evaluate(async ({ seat, riichi, reverse }) => {
      window.coverageHandle?.cancel()
      document.body.innerHTML = `<div class="pov-p${seat}" style="position:absolute;left:450px;top:400px"><div class="river-row"><div class="tileDiv ${riichi ? 'river-riichi' : ''}" data-hand-seat="${seat}"><img class="tileImg" src="/src/assets/tiles/Regular_shortnames/5m.svg"></div></div></div>`
      const source = document.querySelector('.tileDiv'), image = source.querySelector('img'); await image.decode()
      const rect = image.getBoundingClientRect()
      const direction = seat * Math.PI / 2
      const dx = Math.round(Math.cos(direction) * 280), dy = Math.round(Math.sin(direction) * 280)
      window.coverageOptions = { source, image, effects: [], duration: 110, exposure: 3000 / 165,
        fromX: reverse ? 0 : -dx, fromY: reverse ? 0 : -dy, toX: reverse ? -dx : 0, toY: reverse ? -dy : 0 }
      window.coverageOriginal = { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } }
      return window.coverageOriginal.rect
    }, { seat, riichi, reverse })
    const plain = await page.screenshot({ clip: prepared })
    const setup = await page.evaluate(() => {
      const start = performance.now()
      window.coverageHandle = window.coverageApi.prepareDiscardCoverage(window.coverageOptions)
      if (!window.coverageHandle) throw Error('Coverage unexpectedly fell back')
      window.coverageAnimations = [...document.querySelector('.discard-flight-coverage').querySelectorAll('*')].flatMap(n => n.getAnimations())
      window.coverageAnimations.forEach(a => { a.pause(); a.currentTime = window.coverageHandle.duration - .001 })
      return { ms: performance.now() - start, count: document.querySelectorAll('.discard-flight-coverage-sample').length,
        clip: { ...window.coverageOriginal.rect, x: window.coverageOriginal.rect.x + window.coverageOptions.toX,
          y: window.coverageOriginal.rect.y + window.coverageOptions.toY } }
    })
    const overlap = await page.screenshot({ clip: setup.clip })
    if ((seat === 0 || seat === 3) && !riichi && !reverse) {
      fs.writeFileSync(path.join(evidence, `${label}-plain.png`), plain)
      fs.writeFileSync(path.join(evidence, `${label}-overlap.png`), overlap)
    }
    const error = await page.evaluate(async images => {
      const arrays = await Promise.all(images.map(async base64 => {
        const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
        return context.getImageData(0, 0, canvas.width, canvas.height).data
      }))
      let sum = 0, max = 0, flatMax = 0
      for (let i = 0; i < arrays[0].length; i++) { const delta = Math.abs(arrays[0][i] - arrays[1][i]); sum += delta; max = Math.max(max, delta) }
      // Composited edges can use a different subpixel raster phase. Check color
      // normalization separately in locally uniform, opaque face interiors.
      const image = new Image(); image.src = `data:image/png;base64,${images[0]}`; await image.decode()
      for (let y = 2; y < image.height - 2; y++) for (let x = 2; x < image.width - 2; x++) {
        const i = (y * image.width + x) * 4
        for (let c = 0; c < 3; c++) {
          const values = [-1, 0, 1].flatMap(dy => [-1, 0, 1].map(dx => arrays[0][i + (dy * image.width + dx) * 4 + c]))
          if (Math.max(...values) - Math.min(...values) < 3) flatMax = Math.max(flatMax, Math.abs(arrays[0][i + c] - arrays[1][i + c]))
        }
      }
      return { mean: sum / arrays[0].length, max, flatMax }
    }, [plain.toString('base64'), overlap.toString('base64')])
    assert.ok(error.mean < 5 && error.flatMax < 5, `${label}: canonical settled artwork/brightness: ${JSON.stringify({ seat, riichi, reverse, error })}`)
    const sweep = await page.evaluate(() => {
      window.coverageAnimations.forEach(a => { a.currentTime = 22 })
      const samples = [...document.querySelectorAll('.discard-flight-coverage-sample')]
      return [samples[0], samples.at(-1)].map(node => {
        const r = node.querySelector('img').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
    })
    const screenshot = await page.screenshot()
    const signal = await page.evaluate(async ({ base64, sweep }) => {
      const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
      let minimum = Infinity
      for (let i = 0; i <= 200; i++) {
        const x = Math.floor((sweep[0].x + (sweep[1].x - sweep[0].x) * i / 200) * devicePixelRatio)
        const y = Math.floor((sweep[0].y + (sweep[1].y - sweep[0].y) * i / 200) * devicePixelRatio)
        const p = context.getImageData(x, y, 1, 1).data
        minimum = Math.min(minimum, p[0] + p[1] + p[2] - (2 + 25 + 30))
      }
      return minimum
    }, { base64: screenshot.toString('base64'), sweep })
    assert.ok(signal > 3, `${label}: continuous swept centerline: ${JSON.stringify({ seat, riichi, reverse, signal })}`)
    if (seat === 3 && !riichi && !reverse) fs.writeFileSync(path.join(evidence, `${label}.png`), screenshot)
    await page.evaluate(() => { window.coverageHandle.cancel(); if (document.querySelector('.discard-flight-coverage') || window.coverageOptions.source.style.opacity) throw Error('Cancel leaked its layer or source opacity') })
    results.push({ label, seat, riichi, reverse, ...setup, error, minimumSignal: signal })
  }
  await page.evaluate(() => {
    const source = window.coverageOptions.source
    const supports = CSS.supports, animate = Element.prototype.animate
    CSS.supports = () => false
    try { if (window.coverageApi.prepareDiscardCoverage(window.coverageOptions)) throw Error('Unsupported blend did not fall back') }
    finally { CSS.supports = supports }
    let calls = 0
    Element.prototype.animate = function (...args) { if (++calls === 4) throw Error('Injected preparation failure'); return animate.apply(this, args) }
    try { if (window.coverageApi.prepareDiscardCoverage(window.coverageOptions)) throw Error('Failed preparation was accepted') }
    finally { Element.prototype.animate = animate }
    if (document.querySelector('.discard-flight-coverage') || source.style.opacity) throw Error('Failed preparation leaked state')
    source.style.setProperty('opacity', '.8', 'important')
    const handle = window.coverageApi.prepareDiscardCoverage(window.coverageOptions)
    window.dispatchEvent(new Event('resize'))
    if (document.querySelector('.discard-flight-coverage') || source.style.opacity !== '0.8' || source.style.getPropertyPriority('opacity') !== 'important') throw Error('Resize did not restore source style')
    handle.cancel(); source.style.removeProperty('opacity')
    const interrupted = window.coverageApi.prepareDiscardCoverage(window.coverageOptions)
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    if (document.querySelector('.discard-flight-coverage') || source.style.opacity) throw Error('A layout gesture left its old overlay active')
    interrupted.cancel()
    const request = window.requestAnimationFrame, cancel = window.cancelAnimationFrame
    const queue = new Map(); let sequence = 0, busy = false
    window.requestAnimationFrame = callback => { queue.set(++sequence, callback); return sequence }
    window.cancelAnimationFrame = id => { queue.delete(id) }
    const sampler = window.coverageApi.createExposureSampler(() => busy)
    const step = time => { const [id, callback] = queue.entries().next().value; queue.delete(id); callback(time) }
    try {
      sampler.start(); sampler.start()
      if (queue.size !== 1 || sampler.exposure() !== 0) throw Error('Sampler starts bounded and has a sharp warmup fallback')
      for (const time of [6, 12, 18, 24, 30]) step(time)
      if (sampler.exposure() !== 6) throw Error('Sampler lost its update interval')
      busy = true; step(200); step(400)
      busy = false; step(406); step(412)
      if (sampler.exposure() !== 6) throw Error('Sampler learned its own flight/preparation stall')
      sampler.stop()
      if (queue.size || sampler.exposure() !== 0) throw Error('Sampler stop leaked a callback or cadence state')
    } finally { sampler.stop(); window.requestAnimationFrame = request; window.cancelAnimationFrame = cancel }
  })
  // Observe steady native playback separately from screenshot readbacks.
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.animations,blink.user_timing', transferMode: 'ReturnAsStream' })
  const stamp = await page.evaluate(() => {
    let writes = 0
    window.coverageHandle = window.coverageApi.prepareDiscardCoverage(window.coverageOptions)
    const root = document.querySelector('.discard-flight-coverage')
    const observer = new MutationObserver(changes => { writes += changes.length })
    observer.observe(root, { subtree: true, attributes: true })
    window.coverageWrites = () => { observer.disconnect(); return writes }
    performance.mark('rms-coverage-playback-start')
    return performance.now()
  })
  await page.waitForTimeout(250)
  assert.equal(await page.evaluate(() => window.coverageWrites()), 0, 'no animation-time DOM/SVG attribute writes')
  assert.equal(await page.locator('.discard-flight-coverage').count(), 0, 'normal finish releases the temporary layer')
  const done = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve))
  await cdp.send('Tracing.end'); const { stream } = await done
  let trace = ''; for (;;) { const r = await cdp.send('IO.read', { handle: stream }); trace += r.data; if (r.eof) break }
  await cdp.send('IO.close', { handle: stream })
  const events = JSON.parse(trace).traceEvents
  const failures = events.filter(e => e.name === 'Animation' && e.args?.data?.compositeFailed)
  assert.deepEqual(failures, [], `${label}: prepared transforms are compositor eligible`)
  const mark = events.find(e => e.name === 'rms-coverage-playback-start')
  assert.ok(mark, 'native playback has a trace time reference')
  const steadyPaints = events.filter(e => e.name === 'Paint' && e.ts > mark.ts + 30000 && e.ts < mark.ts + 100000).length
  assert.equal(steadyPaints, 0, `${label}: no repeated main-thread painting during steady flight`)
  results.push({ label, compositorFailures: failures.length, paintEvents: events.filter(e => e.name === 'Paint').length, steadyPaints, stamp })
}
try {
  server = await createServer({ root, mode: 'ui-test', cacheDir: path.join(temporary, 'vite-cache'),
    optimizeDeps: { entries: ['scripts/visual-tests/discard-motion/preview.ts'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  for (const [software, ratio] of [[false, 1], [true, 1], [false, 1.25], [false, 2]]) {
    browser = await chromium.launch({ headless: true, args: software ? ['--disable-gpu'] : [] })
    const page = await browser.newPage({ deviceScaleFactor: ratio })
    await check(page, `${software ? 'software' : 'default'}-${ratio}`, ratio === 1)
    await browser.close(); browser = null
  }
  desktop = await electron.launch({ args: [path.join(root, 'scripts/electron-ui-test-main.cjs')], env: { ...process.env, RMS_UI_TEST_URL: server.resolvedUrls.local[0] } })
  await check(await desktop.firstWindow(), 'electron', false)
  console.log(`Discard coverage pixel/lifecycle checks passed: ${results.filter(r => r.seat !== undefined).length} poses; software, DPR 1/1.25/2 and Electron; no compositor failures.`)
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2))
} finally {
  try { await desktop?.close() } finally {
    try { await browser?.close() } finally {
      try { await server?.close() } finally { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
    }
  }
}
const navigation = spawnSync(process.execPath, [path.join(root, 'scripts/check-analysis-ui.mjs')], {
  cwd: root, stdio: 'inherit', env: { ...process.env, RMS_UI_DISCARD_ONLY: '1', RMS_UI_COVERAGE_TRIAL: '1' },
})
if (navigation.error) throw navigation.error
process.exitCode = navigation.status ?? 1
