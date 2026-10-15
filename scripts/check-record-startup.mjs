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
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()), false)
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
    const client = await page.context().newCDPSession(page)
    await client.send('Performance.enable')
    await client.send('Profiler.enable')
    await client.send('Profiler.start')
    const traceEvents = []
    if (process.env.RMS_RECORD_MOTION_TRACE) {
      client.on('Tracing.dataCollected', ({ value }) => traceEvents.push(...value))
      await client.send('Tracing.start', { categories: 'devtools.timeline,blink,cc', transferMode: 'ReportEvents' })
    }
    const before = await client.send('Performance.getMetrics')
    const motion = await page.evaluate(async () => {
      const frameTimes = [], visits = [], longTasks = [], zooms = new Set()
      const vm = document.querySelector('#app').__vue_app__._instance.setupState
      const initial = { node: vm.gameView.currentNodeId, context: vm.currentViewRequestContext(), mode: vm.status.mode }
      const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration }))))
      observer.observe({ type: 'longtask' })
      let active = true
      const sample = now => {
        frameTimes.push(now)
        zooms.add(vm.tableZoom)
        if (visits.at(-1) !== vm.gameView.currentNodeId) visits.push(vm.gameView.currentNodeId)
        if (active) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
      for (const direction of [-1, 1]) for (let i = 0; i < 20; i++) {
        document.querySelector('.grid-main').dispatchEvent(new WheelEvent('wheel', { deltaY: direction * 100, bubbles: true, cancelable: true }))
        await new Promise(resolve => setTimeout(resolve, 80))
      }
      await new Promise(resolve => setTimeout(resolve, 350))
      active = false
      observer.disconnect()
      const intervals = frameTimes.slice(1).map((time, index) => time - frameTimes[index]).sort((a, b) => a - b)
      return { initial, final: { node: vm.gameView.currentNodeId, context: vm.currentViewRequestContext(), mode: vm.status.mode },
        backendNode: (await window.studioAPI.getGameView()).view.currentNodeId,
        zooms: [...zooms], visits: visits.length, frames: frameTimes.length, median: intervals[Math.floor(intervals.length / 2)],
        p95: intervals[Math.floor(intervals.length * .95)], max: intervals.at(-1), longTasks }
    })
    const after = await client.send('Performance.getMetrics')
    const { profile } = await client.send('Profiler.stop')
    if (process.env.RMS_RECORD_MOTION_TRACE) {
      const complete = new Promise(resolve => client.once('Tracing.tracingComplete', resolve))
      await client.send('Tracing.end')
      await complete
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
    await fs.writeFile(process.env.RMS_RECORD_MOTION_PROFILE, JSON.stringify({ motion, work, hotFunctions, profile, navigation, traceEvents }))
    console.log(JSON.stringify({ motion, work, navigation }))
    assert.ok(motion.visits >= 10, 'the motion probe must observe actual renderer frame commits')
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
