import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { _electron as electron } from 'playwright'

// Exercise the old exit file through real startup, including the next empty
// startup after explicit discard. An optional source is copied, never edited.
const root = path.resolve(import.meta.dirname, '..')
const source = path.resolve(process.argv[2] || path.join(root, 'examples/example-record.mjstudio'))
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rms-record-startup-'))
const recovery = path.join(directory, 'records', '.recovery')
await fs.mkdir(recovery, { recursive: true })
await fs.copyFile(source, path.join(recovery, '未保存的对局.mjstudio'))
await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ display: { language: 'zh-CN' },
  records: { saveRecoveryOnExit: true },
  engines: { schemaVersion: 2, profiles: [], loadedProfileIds: [], outputAssignments: {} } }))
const server = await createServer({ root, mode: 'desktop-test', server: { host: '127.0.0.1', port: 0, strictPort: false } })
let application
const errors = []
async function launch() {
  application = await electron.launch({ args: [path.join(root, 'scripts/electron-record-test-main.cjs')],
    env: { ...process.env, VITE_DEV_SERVER_URL: server.resolvedUrls.local[0], RMS_RECORD_DESKTOP_TEST_DIR: directory } })
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
    process.env.RMS_RECORD_MOTION_FOCUSED === '1' && process.env.RMS_RECORD_MOTION_VISIBLE === '1')
  return page
}
async function closeWindow() {
  const exited = application.waitForEvent('close')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await exited
  application = null
}
try {
  await server.listen()
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
    const artwork = await page.evaluate(() => ({ pixelRatio: window.devicePixelRatio,
      images: [...document.querySelectorAll('img.tileImg,img.mahjong-tile-artwork')]
        .reduce((counts, image) => { counts[image.src.startsWith('blob:') ? 'cached' : 'vector']++; return counts }, { cached: 0, vector: 0 }) }))
    const surface = await application.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { visible: window.isVisible(), focused: window.isFocused(), opacity: window.getOpacity(),
        bounds: window.getBounds(), display: screen.getDisplayMatching(window.getBounds()) }
    })
    const visibility = await page.evaluate(() => document.visibilityState)
    if (process.env.RMS_RECORD_MOTION_VISIBLE === '1') {
      assert.equal(surface.opacity, 1)
      if (process.env.RMS_RECORD_MOTION_FOCUSED === '1') assert.equal(surface.focused, true)
      assert.equal(visibility, 'visible', 'an occluded surface is not a visible rendering baseline')
    }
    const client = await page.context().newCDPSession(page)
    await client.send('Performance.enable')
    const recordCpu = !process.env.RMS_RECORD_MOTION_SAMPLE_ONLY
    if (recordCpu) {
      await client.send('Profiler.enable')
      await client.send('Profiler.start')
    }
    const traceEvents = []
    if (process.env.RMS_RECORD_MOTION_TRACE) {
      client.on('Tracing.dataCollected', ({ value }) => traceEvents.push(...value))
      await client.send('Tracing.start', { categories: 'devtools.timeline,blink,cc,benchmark,gpu,viz,disabled-by-default-devtools.timeline.frame', transferMode: 'ReportEvents' })
    }
    const before = await client.send('Performance.getMetrics')
    const motion = await page.evaluate(async (pair) => {
      const frameTimes = [], timelineTimes = [], visits = [], longTasks = [], zooms = new Set(), flights = []
      const probeStartedAt = performance.now()
      console.timeStamp(`RMS-MOTION-START:${probeStartedAt}`)
      const vm = document.querySelector('#app').__vue_app__._instance.setupState
      const initial = { node: vm.gameView.currentNodeId, context: vm.currentViewRequestContext(), mode: vm.status.mode }
      visits.push(initial.node)
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration }))))
      observer.observe({ type: 'longtask' })
      let active = true, frame = 0
      const sample = timeline => {
        frameTimes.push(performance.now())
        timelineTimes.push(timeline)
        zooms.add(vm.tableZoom)
        if (visits.at(-1) !== vm.gameView.currentNodeId) visits.push(vm.gameView.currentNodeId)
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
            document.querySelector('.grid-main').dispatchEvent(new WheelEvent('wheel', {
              deltaY: direction * 100, bubbles: true, cancelable: true,
            }))
            await new Promise(resolve => setTimeout(resolve, 700))
            const expected = pair[direction > 0 ? 1 : 0]
            if (vm.gameView.currentNodeId !== expected) throw new Error(`Expected ${expected}, got ${vm.gameView.currentNodeId}`)
          }
        } else for (const direction of [-1, 1]) for (let i = 0; i < 20; i++) {
          document.querySelector('.grid-main').dispatchEvent(new WheelEvent('wheel', { deltaY: direction * 100, bubbles: true, cancelable: true }))
          await new Promise(resolve => setTimeout(resolve, 80))
        }
        await new Promise(resolve => setTimeout(resolve, 350))
      } finally {
        active = false
        cancelAnimationFrame(frame)
        observer.disconnect()
        Element.prototype.animate = animate
      }
      const intervals = frameTimes.slice(1).map((time, index) => time - frameTimes[index]).sort((a, b) => a - b)
      return { initial, final: { node: vm.gameView.currentNodeId, context: vm.currentViewRequestContext(), mode: vm.status.mode },
        backendNode: (await window.studioAPI.getGameView()).view.currentNodeId,
        zooms: [...zooms], visits: visits.length, frames: frameTimes.length, median: intervals[Math.floor(intervals.length / 2)],
        p95: intervals[Math.floor(intervals.length * .95)], max: intervals.at(-1), longTasks,
        flightWindows: flights.map(flight => {
          if (!Number.isFinite(flight.startTime)) return { ...flight, callbackCount: null, maximumCallbackGapMs: null }
          const callbacks = frameTimes.filter(time => time >= flight.startTime && time < flight.startTime + flight.duration)
          const times = [flight.startTime, ...callbacks, flight.startTime + flight.duration]
          return { ...flight, callbackCount: callbacks.length,
            maximumCallbackGapMs: Math.max(...times.slice(1).map((time, index) => time - times[index])) }
        }), probeStartedAt, callbackArrivals: frameTimes, callbackTimelineStamps: timelineTimes }
    }, pair || null)
    const after = await client.send('Performance.getMetrics')
    const { profile } = recordCpu ? await client.send('Profiler.stop') : { profile: { nodes: [], samples: [], timeDeltas: [] } }
    if (process.env.RMS_RECORD_MOTION_TRACE) {
      const complete = new Promise(resolve => client.once('Tracing.tracingComplete', resolve))
      let timer
      try {
        await client.send('Tracing.end')
        await Promise.race([complete, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Rendering trace did not complete.')), 15000)
        })])
        assert.ok(traceEvents.length, 'a completed trace must contain events')
      } finally { clearTimeout(timer) }
    }
    await client.detach()
    const first = Object.fromEntries(before.metrics.map(({ name, value }) => [name, value]))
    const work = Object.fromEntries(after.metrics.filter(({ name }) => /Duration|Count/.test(name))
      .map(({ name, value }) => [name, value - (first[name] || 0)]))
    const totals = new Map()
    profile.samples.forEach((id, index) => totals.set(id, (totals.get(id) || 0) + profile.timeDeltas[index]))
    const hotFunctions = profile.nodes.map(node => ({ ...node.callFrame, milliseconds: (totals.get(node.id) || 0) / 1000 }))
      .sort((a, b) => b.milliseconds - a.milliseconds).slice(0, 35)
    const navigation = await application.evaluate(() => global.recordDesktopTest.navigation)
    await fs.writeFile(process.env.RMS_RECORD_MOTION_PROFILE, JSON.stringify({ motion, work, artwork, hotFunctions, profile, navigation, traceEvents,
      surface: { ...surface, documentVisibility: visibility },
      evidence: { nativeControlUsed: false, overlayState: process.env.RMS_RECORD_MOTION_OVERLAY_STATE || 'unverified',
        frameMetric: 'main-thread callback arrivals, not physical presented frames' } }))
    const { callbackArrivals, callbackTimelineStamps, ...motionSummary } = motion
    console.log(JSON.stringify({ motion: motionSummary, work, navigation }))
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
  await server.close()
  await fs.rm(directory, { recursive: true, force: true })
}
