import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { createServer } from 'vite'
import { _electron as electron } from 'playwright'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { decodeGameRecord } = require('../electron/main/state/game-record-codec')

const root = path.resolve(import.meta.dirname, '..')
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rms-record-desktop-'))
const record = path.join(directory, 'records', 'example-record.mjstudio')
let server
let application
const errors = []
const timings = []
async function launch() {
  const app = await electron.launch({ args: [path.join(root, 'scripts/electron-record-test-main.cjs')],
    env: { ...process.env, VITE_DEV_SERVER_URL: server.resolvedUrls.local[0], RMS_RECORD_DESKTOP_TEST_DIR: directory } })
  application = app
  const page = await app.firstWindow()
  page.setDefaultTimeout(20_000)
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.shell:not(.tile-artwork-pending)').waitFor({ timeout: 30_000 })
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
  return { app, page }
}
async function timed(name, task) {
  const start = performance.now()
  await task()
  const ms = Math.round(performance.now() - start)
  timings.push({ name, ms })
  console.log(JSON.stringify({ stage: name, ms }))
}
try {
  await fs.mkdir(path.dirname(record))
  await fs.copyFile(path.join(root, 'examples', 'example-record.mjstudio'), record)
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ display: { language: 'zh-CN' },
    records: { saveRecoveryOnExit: true, analysisCacheMiB: 4 },
    engines: { schemaVersion: 2, profiles: [], loadedProfileIds: [], outputAssignments: {} } }))
  server = await createServer({ root, mode: 'desktop-test', cacheDir: path.join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  let launched = await launch()
  application = launched.app
  let page = launched.page
  const toolbar = () => page.locator('.toolbar')
  await timed('first-open', async () => {
    await toolbar().getByRole('button', { name: '打开', exact: true }).click()
    await page.locator('.record-operation-overlay').waitFor()
    await page.locator('textarea.node-comment').waitFor()
    await page.locator('.record-operation-overlay').waitFor({ state: 'hidden', timeout: 60_000 })
  })
  assert.equal(await application.evaluate(() => global.recordDesktopTest.dialogs[0].defaultPath), path.join(directory, 'records'))
  await page.locator('textarea.node-comment').fill('Desktop saved comment — 牌譜')
  await timed('save-with-draft-flush', async () => {
    await toolbar().getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('.record-operation-overlay').waitFor()
    const deadline = performance.now() + 10_000
    while (!await application.evaluate(() => Boolean(global.recordDesktopTest.lastSaveToken))) {
      if (performance.now() > deadline) throw new Error('Save capture did not complete.')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    await page.locator('textarea.node-comment').click()
    await page.locator('textarea.node-comment').fill('Live edit after the saved cutoff — 继续编辑')
    const statusStart = performance.now()
    await page.evaluate(() => window.studioAPI.getGameView())
    console.log(JSON.stringify({ stage: 'foreground-during-save', ms: Math.round(performance.now() - statusStart) }))
    await page.locator('.record-operation-overlay').waitFor({ state: 'hidden', timeout: 90_000 })
  })
  assert.equal((await fs.readFile(record)).subarray(0, 8).toString(), 'MJSTBLK2')
  const captured = decodeGameRecord(await fs.readFile(record))
  assert.equal(captured.game.nodes[captured.game.currentNodeId].comment, 'Desktop saved comment — 牌譜')
  assert.equal(await page.locator('textarea.node-comment').inputValue(), 'Live edit after the saved cutoff — 继续编辑')
  assert.equal(await page.evaluate(() => window.studioAPI.getRecordDirty()), true)
  await toolbar().getByRole('button', { name: '保存', exact: true }).click()
  await page.locator('.record-operation-overlay').waitFor({ state: 'hidden', timeout: 30_000 })
  await toolbar().getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('textarea.node-comment').waitFor({ state: 'hidden' })
  await timed('native-reopen', async () => {
    await toolbar().getByRole('button', { name: '打开', exact: true }).click()
    await page.locator('textarea.node-comment').waitFor()
    await page.locator('.record-operation-overlay').waitFor({ state: 'hidden' })
  })
  assert.equal(await page.locator('textarea.node-comment').inputValue(), 'Live edit after the saved cutoff — 继续编辑')
  // No blur/debounce wait: closing must flush this exact frontend draft.
  await page.locator('textarea.node-comment').fill('Desktop unsaved exit draft — 未保存')
  const closed = new Promise(resolve => application.once('close', resolve))
  await timed('window-close-with-draft', async () => {
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
    await closed
  })
  application = null
  launched = await launch()
  application = launched.app
  page = launched.page
  await page.locator('textarea.node-comment').waitFor({ timeout: 60_000 })
  assert.equal(await page.locator('textarea.node-comment').inputValue(), 'Desktop unsaved exit draft — 未保存')
  assert.equal(await page.evaluate(() => window.studioAPI.getRecordDirty()), true)
  // A cancelled picker after consent must preserve the recovered record/draft.
  await application.evaluate(() => { global.recordDesktopTest.nextOpen = null })
  await toolbar().getByRole('button', { name: '打开', exact: true }).click()
  await toolbar().getByRole('button', { name: '丢弃', exact: true }).click()
  assert.equal(await page.locator('textarea.node-comment').inputValue(), 'Desktop unsaved exit draft — 未保存')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ result: 'Full hidden Electron/Vue/IPC/backend open/save/close/recovery passed', timings }))
} finally {
  try {
    await application?.close()
  } finally {
    try {
      await server?.close()
    } finally {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
}
