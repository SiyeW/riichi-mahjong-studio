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
  await page.locator('.shell:not(.tile-artwork-pending)').waitFor()
  await page.locator('.record-operation-overlay').waitFor({ state: 'hidden' })
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
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
