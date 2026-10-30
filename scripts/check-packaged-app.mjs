import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron } from 'playwright'

const root = path.resolve(import.meta.dirname, '..')
const source = path.join(root, 'release/electron/win-unpacked')
const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rms-packaged-check-')))
const directory = path.join(temporary, 'app')
const executable = path.join(directory, 'Riichi Mahjong Studio.exe')
const errors = []
let application

// Packaged Electron deliberately ignores --require. Pause before its entrypoint
// instead; only the copied test process may receive our window/profile hooks.
async function installStartupHooks(port) {
  const deadline = Date.now() + 15_000
  let target
  while (!target) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json())[0] } catch {}
    if (Date.now() > deadline) throw Error('Packaged inspector did not start')
    if (!target) await delay(20)
  }
  const actual = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); `
    + `$rmsPid=Get-NetTCPConnection -State Listen -LocalAddress 127.0.0.1 -LocalPort ${port} | Select-Object -First 1 -ExpandProperty OwningProcess; `
    + `(Get-CimInstance Win32_Process -Filter "ProcessId=$rmsPid").ExecutablePath`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim()
  assert.equal(await fs.realpath(actual), await fs.realpath(executable), 'verify listener ownership before debugger commands')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const waiting = new Map()
  let sequence = 0, owned = false, installed = false, settled = false, entryBreakpoint
  const scripts = new Map()
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence
    waiting.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return new Promise((resolve, reject) => {
    const fail = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (owned && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: ++sequence, method: 'Runtime.evaluate', params: { expression: 'process.exit(2)' } }))
      }
      for (const pending of waiting.values()) pending.reject(error)
      waiting.clear()
      socket.close()
      reject(error)
    }
    const timer = setTimeout(() => { void fail(Error('Packaged startup hook deadline expired')) }, 15_000)
    socket.addEventListener('error', () => { void fail(Error('Packaged inspector connection failed')) })
    socket.addEventListener('open', async () => {
      try {
        await command('Debugger.enable')
        entryBreakpoint = (await command('Debugger.setBreakpointByUrl', {
          urlRegex: path.basename(temporary) + '[/\\\\].*[/\\\\]electron[/\\\\]main[/\\\\]index\\.js$', lineNumber: 0,
        })).breakpointId
        await command('Runtime.runIfWaitingForDebugger')
      } catch (error) { void fail(error) }
    })
    socket.addEventListener('message', async event => {
      const message = JSON.parse(event.data)
      if (message.id) {
        const pending = waiting.get(message.id)
        waiting.delete(message.id)
        if (message.error) pending?.reject(Error(message.error.message))
        else pending?.resolve(message.result)
      } else if (message.method === 'Debugger.scriptParsed') {
        scripts.set(message.params.scriptId, message.params.url)
      } else if (message.method === 'Debugger.paused' && !settled) {
        try {
          const frame = message.params.callFrames[0]
          const actual = await command('Debugger.evaluateOnCallFrame', {
            callFrameId: frame.callFrameId, expression: 'process.execPath', returnByValue: true,
          })
          assert.equal(actual.result.value, executable, 'never instrument another process')
          owned = true
          const url = (frame.url || scripts.get(frame.location.scriptId) || '').replaceAll('\\', '/')
          const entry = message.params.hitBreakpoints?.includes(entryBreakpoint)
            || url.includes(path.basename(temporary)) && url.endsWith('/electron/main/index.js')
          if (!entry && !url) throw Error('Cannot identify paused packaged startup script')
          if (entry) {
            const result = await command('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId,
              expression: `require(${JSON.stringify(path.join(root, 'scripts/fixtures/packaged-startup.cjs'))}); JSON.stringify({userData:require('electron').app.getPath('userData'),installed:Array.isArray(global.packagedSmokeWarnings)})`, returnByValue: true })
            if (result.exceptionDetails) throw Error('Packaged startup hooks could not load')
            const isolation = JSON.parse(result.result.value)
            assert.equal(isolation.installed, true)
            assert.equal(isolation.userData, path.join(directory, 'browser'), 'isolate before production entrypoint executes')
            installed = true
          }
          await command('Debugger.resume')
          if (installed) {
            settled = true
            clearTimeout(timer)
            socket.close()
            resolve()
          }
        } catch (error) { void fail(error) }
      }
    })
  })
}

try {
  await fs.cp(source, directory, { recursive: true, filter: entry => {
    const first = path.relative(source, entry).split(path.sep)[0]
    return !['records', 'config.json', 'logs'].includes(first)
  } })
  await fs.mkdir(path.join(directory, 'records'))
  await fs.mkdir(path.join(directory, 'browser'))
  await fs.copyFile(path.join(root, 'examples/example-record.mjstudio'), path.join(directory, 'records/example-record.mjstudio'))
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({
    display: { language: 'zh-CN' }, records: { saveRecoveryOnExit: false },
    engines: { schemaVersion: 2, profiles: [], loadedProfileIds: [], outputAssignments: {} },
  }))
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  const reservation = net.createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const launching = electron.launch({ executablePath: executable,
    args: [`--inspect-brk=127.0.0.1:${port}`],
    env: { ...env, RMS_PACKAGED_TEST_DIR: directory, RMS_BACKEND_CONFIG: path.join(directory, 'config.json') },
    timeout: 30_000,
  })
  try { [application] = await Promise.all([launching, installStartupHooks(port)]) }
  catch (error) { await launching.catch(() => {}); throw error }
  const runtime = await application.evaluate(({ app }) => ({
    packaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData'),
    executable: process.execPath, electron: process.versions.electron, node: process.versions.node,
  }))
  assert.equal(runtime.packaged, true, 'the actual packaged startup path must run')
  assert.equal(await fs.realpath(runtime.executable), await fs.realpath(executable))
  assert.equal(runtime.appPath, path.join(directory, 'resources/app.asar'))
  assert.equal(runtime.userData, path.join(directory, 'browser'))
  assert.equal(runtime.electron, JSON.parse(await fs.readFile(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version)
  console.log(JSON.stringify({ stage: 'packaged-startup-isolated', runtime }))
  const page = await application.firstWindow()
  page.setDefaultTimeout(30_000)
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.shell:not(.tile-artwork-pending)').waitFor()
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
  assert.equal(new URL(page.url()).protocol, 'file:')
  await page.locator('.toolbar').getByRole('button', { name: '打开', exact: true }).click()
  await page.locator('textarea.node-comment').waitFor()
  await page.locator('.record-operation-overlay').waitFor({ state: 'hidden' })
  const comment = `Packaged Electron ${runtime.electron} — 牌譜`
  await page.locator('textarea.node-comment').fill(comment)
  await page.locator('.toolbar').getByRole('button', { name: '另存为', exact: true }).click()
  await page.locator('.record-operation-overlay').waitFor({ state: 'visible' })
  await page.locator('.record-operation-overlay').waitFor({ state: 'hidden', timeout: 90_000 })
  const saved = path.join(directory, 'records/saved.mjstudio')
  assert.equal((await fs.readFile(saved)).subarray(0, 8).toString(), 'MJSTBLK2')
  assert.equal(await page.locator('textarea.node-comment').inputValue(), comment)
  assert.equal(await page.evaluate(() => window.studioAPI.getRecordDirty()), false)
  assert.deepEqual(await application.evaluate(() => global.packagedSmokeWarnings), [])
  assert.deepEqual(errors, [])
  const closed = application.waitForEvent('close', { timeout: 60_000 })
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
  await closed
  application = null
  console.log(JSON.stringify({ result: 'Actual packaged executable/asar/frozen backend open/save/close passed', runtime }))
} finally {
  try {
    if (application) {
      const closed = application.waitForEvent('close', { timeout: 10_000 })
      await application.evaluate(({ app }) => { setTimeout(() => app.exit(1), 0) }).catch(() => {})
      await closed
    }
  } finally {
    assert.equal(path.dirname(temporary), await fs.realpath(os.tmpdir()))
    assert.ok(path.basename(temporary).startsWith('rms-packaged-check-'))
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
