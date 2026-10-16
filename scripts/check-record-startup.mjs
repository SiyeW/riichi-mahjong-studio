import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createServer } from 'vite'
import { _electron as electron } from 'playwright'
import { stableForegroundSample } from '../src/testing/motionProbeSurface.ts'
import { readRenderingTrace } from '../src/testing/renderingTrace.ts'

// Exercise the old exit file through real startup, including the next empty
// startup after explicit discard. An optional source is copied, never edited.
const root = path.resolve(import.meta.dirname, '..')
const source = path.resolve(process.argv[2] || path.join(root, 'examples/example-record.mjstudio'))
const rasterization = process.env.RMS_RECORD_MOTION_RASTERIZATION || 'default'
assert.ok(['default', 'cpu'].includes(rasterization), 'motion rasterization must be default or cpu')
assert.ok(rasterization === 'default' || process.env.RMS_RECORD_MOTION_PROFILE,
  'a rasterization intervention requires an explicit motion profile')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rms-record-startup-'))
const recovery = path.join(directory, 'records', '.recovery')
await fs.mkdir(recovery, { recursive: true })
await fs.copyFile(source, path.join(recovery, '未保存的对局.mjstudio'))
await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ display: { language: 'zh-CN' },
  records: { saveRecoveryOnExit: true },
  engines: { schemaVersion: 2, profiles: [], loadedProfileIds: [], outputAssignments: {} } }))
const externalRendererUrl = process.env.RMS_RECORD_TEST_URL || null
const server = externalRendererUrl ? null
  : await createServer({ root, mode: 'desktop-test', server: { host: '127.0.0.1', port: 0, strictPort: false } })
let application
const errors = []
async function launch() {
  application = await electron.launch({ args: [...(rasterization === 'cpu' ? ['--disable-gpu-rasterization'] : []),
    path.join(root, 'scripts/electron-record-test-main.cjs')],
    env: { ...process.env, VITE_DEV_SERVER_URL: externalRendererUrl || server.resolvedUrls.local[0], RMS_RECORD_DESKTOP_TEST_DIR: directory } })
  const page = await application.firstWindow()
  page.setDefaultTimeout(30_000)
  page.on('pageerror', error => errors.push(error.message))
  if (process.env.RMS_RECORD_MOTION_PROFILE) page.on('console', message => {
    if (message.type() === 'error') console.error(message.text())
  })
  await page.locator('.shell:not(.tile-artwork-pending)').waitFor()
  await page.locator('.record-operation-overlay').waitFor({ state: 'hidden' })
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), Boolean(process.env.RMS_RECORD_MOTION_PROFILE))
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
    Boolean(process.env.RMS_RECORD_MOTION_PROFILE && process.env.RMS_RECORD_MOTION_FOCUSED === '1'
      && process.env.RMS_RECORD_MOTION_VISIBLE === '1'))
  return page
}
async function closeWindow() {
  const exited = application.waitForEvent('close')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await exited
  application = null
}
try {
  await server?.listen()
  let page = await launch()
  await page.locator('textarea.node-comment').waitFor()
  const initial = await page.evaluate(() => window.studioAPI.getGameView())
  assert.equal(initial.state.gameLoaded, true)
  assert.ok(initial.view.tree.nodes.some(node => node.id === initial.view.currentNodeId && node.parentId),
    'the recovered cursor has a previous frame for the wheel test')
  if (initial.state.mode === 'play') {
    await page.locator('.grid-main').dispatchEvent('wheel', { deltaY: -100 })
    assert.equal((await page.evaluate(() => window.studioAPI.getGameView())).view.currentNodeId, initial.view.currentNodeId)
    await page.locator('.toolbar').getByRole('button', { name: '进入研究模式', exact: true }).click()
    await page.locator('.toolbar').getByRole('button', { name: '进入对局模式', exact: true }).waitFor()
  }
  await page.locator('.grid-main').dispatchEvent('wheel', { deltaY: -100 })
  await page.waitForFunction(async original => (await window.studioAPI.getGameView()).view.currentNodeId !== original,
    initial.view.currentNodeId)
  assert.equal(await page.locator('[inert]').count(), 0)
  assert.equal(JSON.parse(await fs.readFile(path.join(recovery, 'legacy-migration.json'), 'utf8')).version, 1)

  if (process.env.RMS_RECORD_MOTION_PROFILE) {
    const pair = process.env.RMS_RECORD_MOTION_PAIR?.split(',')
    if (pair && (pair.length !== 2 || pair.some(node => !node.trim()))) {
      throw new Error('RMS_RECORD_MOTION_PAIR must contain previous,next node IDs.')
    }
    if (process.env.RMS_RECORD_MOTION_SEAT !== undefined) {
      const seat = Number(process.env.RMS_RECORD_MOTION_SEAT)
      assert.ok(Number.isInteger(seat) && seat >= 0 && seat < 4, 'motion seat must be 0-3')
      await page.evaluate(async seat => {
        const vm = document.querySelector('#app').__vue_app__._instance.setupState
        if (vm.status.controlledSeat !== seat) vm.applyStatus(await window.studioAPI.requestSeatSwitch(seat))
      }, seat)
    }
    if (pair) await page.evaluate(async ([previous]) => {
      const vm = document.querySelector('#app').__vue_app__._instance.setupState
      vm.applyGameView((await window.studioAPI.jumpToNode(previous)).view)
    }, pair)
    await page.waitForTimeout(350)
    if (process.env.RMS_RECORD_MOTION_WAIT_ARTWORK === '1') {
      await page.waitForFunction(() => [...document.querySelectorAll('img.tileImg,img.mahjong-tile-artwork')]
        .every(image => image.src.startsWith('blob:')), null, { timeout: 30_000 })
    }
    const artwork = await page.evaluate(async () => ({ pixelRatio: window.devicePixelRatio,
      formats: await Promise.all([...new Set([...document.querySelectorAll('img.tileImg,img.mahjong-tile-artwork')]
        .map(image => image.src))].map(async src => (await (await fetch(src)).blob()).type)),
      minimumBitmapCoverage: Math.min(...[...document.querySelectorAll('img.tileImg,img.mahjong-tile-artwork')]
        .filter(image => image.src.startsWith('blob:')).map(image => {
          const style = getComputedStyle(image)
          const width = parseFloat(style.width) - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
          return image.naturalWidth / (width * window.devicePixelRatio)
        })),
      images: [...document.querySelectorAll('img.tileImg,img.mahjong-tile-artwork')]
        .reduce((counts, image) => { counts[image.src.startsWith('blob:') ? 'cached' : 'vector']++; return counts }, { cached: 0, vector: 0 }) }))
    if (process.env.RMS_RECORD_MOTION_WAIT_ARTWORK === '1') {
      assert.ok(artwork.formats.every(type => type === 'image/png'), 'every rendered face uses an ordinary cached bitmap')
      assert.ok(artwork.minimumBitmapCoverage >= 1, 'cached pixels cover actual content demand')
    }
    async function readSurface() {
      const surface = await application.evaluate(({ BrowserWindow, screen, powerMonitor }) => {
        const window = BrowserWindow.getAllWindows()[0]
        return { visible: window.isVisible(), focused: window.isFocused(), opacity: window.getOpacity(),
          mode: global.recordDesktopTest.surfaceMode,
          invalidations: window.rmsRecordSurfaceEvents.invalidations,
          locks: window.rmsRecordSurfaceEvents.locks,
          power: { idleState: powerMonitor.getSystemIdleState(5), idleSeconds: powerMonitor.getSystemIdleTime(),
            onBattery: powerMonitor.isOnBatteryPower(), preventDisplaySleep: global.recordDesktopTest.preventDisplaySleep },
          bounds: window.getBounds(), display: screen.getDisplayMatching(window.getBounds()) }
      })
      return { ...surface, ...await page.evaluate(() => ({ documentVisibility: document.visibilityState, pixelRatio: window.devicePixelRatio })) }
    }
    const surface = await readSurface()
    if (process.env.RMS_RECORD_MOTION_VISIBLE === '1') {
      assert.equal(surface.opacity, 1)
      if (process.env.RMS_RECORD_MOTION_FOCUSED === '1') assert.equal(surface.focused, true)
      if (process.env.RMS_RECORD_MOTION_ALLOW_LOCKED !== '1') {
        assert.notEqual(surface.power.idleState, 'locked',
          'A locked desktop is not foreground rendering acceptance; explicit diagnostic override is required.')
        assert.notEqual(surface.power.idleState, 'unknown', 'OS foreground state is unavailable.')
      }
      assert.equal(surface.documentVisibility, 'visible', 'an occluded surface is not a visible rendering baseline')
    }
    const client = await page.context().newCDPSession(page)
    if (process.env.RMS_RECORD_MOTION_INPUT === 'trusted') {
      const bounds = await page.locator('.grid-main').boundingBox()
      assert.ok(bounds, 'trusted wheel needs a visible table hit target')
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 4)
      await page.exposeFunction('__rmsMotionWheel', deltaY => page.mouse.wheel(0, deltaY))
    }
    await client.send('Performance.enable')
    const recordCpu = !process.env.RMS_RECORD_MOTION_SAMPLE_ONLY
    if (recordCpu) {
      await client.send('Profiler.enable')
      await client.send('Profiler.start')
    }
    let traceEvents = []
    if (process.env.RMS_RECORD_MOTION_TRACE) {
      const categories = 'devtools.timeline,blink,cc,benchmark,gpu,viz,disabled-by-default-devtools.timeline.frame'
      await client.send('Tracing.start', { categories: process.env.RMS_RECORD_MOTION_TRACE_CATEGORIES || categories, transferMode: 'ReturnAsStream' })
    }
    const before = await client.send('Performance.getMetrics')
    const motion = await page.evaluate(async (pair) => {
      const frameTimes = [], timelineTimes = [], visits = [], longTasks = [], zooms = new Set(), flights = [], inputs = [], commits = []
      const probeStartedAt = performance.now()
      console.timeStamp(`RMS-MOTION-START:${probeStartedAt}`)
      performance.mark(`RMS-MOTION-START:${probeStartedAt}`, { startTime: probeStartedAt })
      const vm = document.querySelector('#app').__vue_app__._instance.setupState
      const initial = { node: vm.gameView.currentNodeId, context: vm.currentViewRequestContext(), mode: vm.status.mode }
      const experimentAdmissionsBefore = window.__rmsFlightExperiment?.admissions || 0
      visits.push(initial.node)
      const table = document.querySelector('.grid-main')
      const wheel = event => inputs.push({ at: performance.now(), deltaY: event.deltaY, trusted: event.isTrusted,
        beforeNode: vm.gameView.currentNodeId })
      table.addEventListener('wheel', wheel, { capture: true })
      const dispatchWheel = deltaY => window.__rmsMotionWheel ? window.__rmsMotionWheel(deltaY)
        : table.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }))
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration }))))
      observer.observe({ type: 'longtask' })
      let active = true, frame = 0
      const sample = timeline => {
        const arrival = performance.now()
        frameTimes.push(arrival)
        timelineTimes.push(timeline)
        zooms.add(vm.tableZoom)
        if (visits.at(-1) !== vm.gameView.currentNodeId) {
          visits.push(vm.gameView.currentNodeId)
          commits.push({ node: vm.gameView.currentNodeId, observedAt: arrival })
        }
        if (active) frame = requestAnimationFrame(sample)
      }
      const animate = Element.prototype.animate
      Element.prototype.animate = function (keyframes, options) {
        const animation = animate.call(this, keyframes, options)
        if (this.hasAttribute('data-pending-discard-seat') || this.classList.contains('discard-return-ghost')) {
          const flight = { node: vm.gameView.currentNodeId, createdAt: performance.now(),
            duration: Number(animation.effect?.getTiming().duration) || 0,
            easing: animation.effect?.getTiming().easing, startTime: null }
          flights.push(flight)
          void animation.ready.then(() => { flight.startTime = animation.startTime }).catch(() => {})
        }
        return animation
      }
      frame = requestAnimationFrame(sample)
      try {
        if (pair) {
          for (let round = 0; round < 4; round++) for (const direction of [1, -1]) {
            await dispatchWheel(direction * 100)
            await new Promise(resolve => setTimeout(resolve, 700))
            const expected = pair[direction > 0 ? 1 : 0]
            if (vm.gameView.currentNodeId !== expected) throw new Error(`Expected ${expected}, got ${vm.gameView.currentNodeId}`)
          }
        } else for (const direction of [-1, 1]) for (let i = 0; i < 20; i++) {
          await dispatchWheel(direction * 100)
          await new Promise(resolve => setTimeout(resolve, 80))
        }
        await new Promise(resolve => setTimeout(resolve, 350))
      } finally {
        active = false
        cancelAnimationFrame(frame)
        observer.disconnect()
        table.removeEventListener('wheel', wheel, true)
        Element.prototype.animate = animate
      }
      const intervals = frameTimes.slice(1).map((time, index) => time - frameTimes[index]).sort((a, b) => a - b)
      return { initial, final: { node: vm.gameView.currentNodeId, context: vm.currentViewRequestContext(), mode: vm.status.mode },
        backendNode: (await window.studioAPI.getGameView()).view.currentNodeId,
        zooms: [...zooms], visits: visits.length, inputs, commits,
        experiment: window.__rmsFlightExperiment ? { ...window.__rmsFlightExperiment,
          admissionsDuringSample: window.__rmsFlightExperiment.admissions - experimentAdmissionsBefore } : undefined,
        frames: frameTimes.length, median: intervals[Math.floor(intervals.length / 2)],
        p95: intervals[Math.floor(intervals.length * .95)], max: intervals.at(-1), longTasks,
        flightWindows: flights.map(flight => {
          if (!Number.isFinite(flight.startTime)) return { ...flight, callbackCount: null, maximumCallbackGapMs: null }
          const callbacks = frameTimes.filter(time => time >= flight.startTime && time < flight.startTime + flight.duration)
          const times = [flight.startTime, ...callbacks, flight.startTime + flight.duration]
          return { ...flight, callbackCount: callbacks.length,
            maximumCallbackGapMs: Math.max(...times.slice(1).map((time, index) => time - times[index])) }
        }), probeStartedAt, callbackArrivals: frameTimes, callbackTimelineStamps: timelineTimes }
    }, pair || null)
    const surfaceAfter = await readSurface()
    const stableForeground = stableForegroundSample(surface, surfaceAfter)
    const after = await client.send('Performance.getMetrics')
    const { profile } = recordCpu ? await client.send('Profiler.stop') : { profile: { nodes: [], samples: [], timeDeltas: [] } }
    if (process.env.RMS_RECORD_MOTION_TRACE) {
      const complete = new Promise(resolve => client.once('Tracing.tracingComplete', resolve))
      let timer
      try {
        await client.send('Tracing.end')
        const result = await Promise.race([complete, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Rendering trace did not complete.')), 15000)
        })])
        assert.ok(result?.stream, 'a completed trace must provide its raw JSON stream')
        traceEvents = await readRenderingTrace(client, result.stream)
        assert.ok(traceEvents.length, 'a completed trace must contain events')
      } finally { clearTimeout(timer) }
    }
    await client.detach()
    const rendererFeatures = await application.evaluate(({ app }) => app.getGPUFeatureStatus())
    if (rasterization === 'cpu') assert.equal(rendererFeatures.rasterization, 'disabled_software',
      'the rasterization intervention must reach the actual renderer')
    // Optional adapter attribution is outside the sampled animation/CPU window.
    const gpu = process.env.RMS_RECORD_MOTION_GPU_INFO === '1'
      ? await application.evaluate(async ({ app }) => ({ features: app.getGPUFeatureStatus(),
        versions: { electron: process.versions.electron, chrome: process.versions.chrome }, info: await app.getGPUInfo('complete') }))
        .catch(error => ({ error: String(error) }))
      : undefined
    const first = Object.fromEntries(before.metrics.map(({ name, value }) => [name, value]))
    const work = Object.fromEntries(after.metrics.filter(({ name }) => /Duration|Count/.test(name))
      .map(({ name, value }) => [name, value - (first[name] || 0)]))
    const totals = new Map()
    profile.samples.forEach((id, index) => totals.set(id, (totals.get(id) || 0) + profile.timeDeltas[index]))
    const hotFunctions = profile.nodes.map(node => ({ ...node.callFrame, milliseconds: (totals.get(node.id) || 0) / 1000 }))
      .sort((a, b) => b.milliseconds - a.milliseconds).slice(0, 35)
    const navigation = await application.evaluate(() => global.recordDesktopTest.navigation)
    await fs.writeFile(process.env.RMS_RECORD_MOTION_PROFILE, JSON.stringify({ motion, work, artwork, hotFunctions, profile, navigation, traceEvents, gpu, rendererFeatures,
      source: { bytes: (await fs.stat(source)).size, sha256: createHash('sha256').update(await fs.readFile(source)).digest('hex') },
      surface, surfaceAfter,
      evidence: { desktopControlToolsUsed: false, overlayState: process.env.RMS_RECORD_MOTION_OVERLAY_STATE || 'unverified',
        nativeWindowSurface: surface.mode === 'native',
        stableForeground,
        inputMode: process.env.RMS_RECORD_MOTION_INPUT === 'trusted' ? 'trusted-browser-wheel' : 'dom-wheel',
        rasterizationRequested: rasterization,
        lockedSession: surface.power.idleState === 'locked' || surfaceAfter.power.idleState === 'locked'
          || surfaceAfter.locks !== surface.locks,
        frameMetric: 'main-thread callback arrivals, not physical presented frames' } }))
    const { callbackArrivals, callbackTimelineStamps, ...motionSummary } = motion
    console.log(JSON.stringify({ motion: motionSummary, work, navigation }))
    if (process.env.RMS_RECORD_MOTION_INPUT === 'trusted') {
      assert.ok(motion.inputs.length && motion.inputs.every(input => input.trusted), 'native-input trials must receive trusted wheel events')
    }
    if (surface.mode === 'native' && process.env.RMS_RECORD_MOTION_ALLOW_LOCKED !== '1') {
      assert.equal(stableForeground, true, 'The foreground surface changed during sampling; results are diagnostic only.')
    }
    assert.ok(motion.visits >= (pair ? 9 : 10), 'the motion probe must observe actual renderer frame commits')
    if (pair) assert.ok(motion.flightWindows.length >= 4, 'the selected pair must exercise actual discard motion')
  }

  await page.locator('.toolbar').getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('.toolbar').getByRole('button', { name: '丢弃', exact: true }).click()
  await page.locator('textarea.node-comment').waitFor({ state: 'hidden' })
  await closeWindow()
  page = await launch()
  assert.equal((await page.evaluate(() => window.studioAPI.getGameView())).state.gameLoaded, false,
    'an explicitly closed record must not be resurrected from the old exit file')
  assert.ok((await fs.stat(path.join(recovery, '未保存的对局.mjstudio'))).size > 0,
    'retiring the automatic fallback does not destroy the original recovery data')
  await closeWindow()
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'Legacy startup, mode-aware wheel navigation, discard and empty restart passed',
    restoredMode: initial.state.mode, restoredNode: initial.view.currentNodeId }))
} finally {
  await application?.close()
  await server?.close()
  await fs.rm(directory, { recursive: true, force: true })
}
