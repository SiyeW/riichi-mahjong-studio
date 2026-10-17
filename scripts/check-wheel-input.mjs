import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createWheelStepAccumulator } from '../src/wheelNavigation.ts'

// OS messages sent only to this test's HWND, not CDP pixel guesses or global
// pointer input. This verifies Windows input/DPI plumbing, not physical hardware.
assert.equal(process.env.RMS_UI_FOREGROUND_AUTHORIZED, '1', 'Native input verification requires current foreground authority')
assert.equal(process.platform, 'win32', 'This native-message fixture is Windows-specific')
const exec = promisify(execFile)
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rms-wheel-'))
try {
  for (const dpr of [1, 1.25, 2]) for (const zoom of [1, 1.25]) {
    const app = await electron.launch({ args: [`--force-device-scale-factor=${dpr}`, path.join(import.meta.dirname, 'electron-wheel-test-main.cjs')],
      env: { ...process.env, RMS_NATIVE_WHEEL_TEST_DATA: directory, RMS_NATIVE_WHEEL_TEST_ZOOM: String(zoom) } })
    try {
      const page = await app.firstWindow()
      await page.waitForFunction(() => Array.isArray(window.samples))
      const handle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString())
      const source = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class WheelProbe{[DllImport("user32.dll")]public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,IntPtr w,IntPtr l,uint f,uint t,out IntPtr r);}'; $r=[IntPtr]::Zero; foreach($d in @(120,240,60,60,-120,-240,-120)) { [void][WheelProbe]::SendMessageTimeout([IntPtr]${handle},0x20A,[IntPtr]($d -shl 16),[IntPtr]((200 -shl 16) -bor 200),2,2000,[ref]$r); Start-Sleep -Milliseconds 80 }`
      await exec('powershell.exe', ['-NoProfile', '-Command', source])
      await page.waitForFunction(() => window.samples.length === 7)
      const samples = await page.evaluate(() => window.samples)
      const wheel = createWheelStepAccumulator()
      assert.ok(samples.every(sample => sample.isTrusted))
      assert.deepEqual(samples.map(sample => wheel.consume(sample)), [-1, -2, 0, -1, 1, 2, 1])
      console.log(JSON.stringify({ dpr, zoom, samples, result: 'native detents and fractional movement conserved' }))
    } finally { await app.close() }
  }
} finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
