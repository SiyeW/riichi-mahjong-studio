import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { _electron as electron } from 'playwright'

// Build the actual production modules without a development server. A small
// dedicated entry exercises worker support/fallback without user settings.
const root = path.resolve(import.meta.dirname, '..')
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'rms-built-coverage-'))
const output = path.join(temporary, 'dist'), results = []
let application
try {
  const built = await build({ root, mode: 'production', logLevel: 'warn', build: { outDir: output, emptyOutDir: false,
    rollupOptions: { input: path.join(root, 'scripts/visual-tests/discard-motion/compiled.html') } } })
  const html = (Array.isArray(built) ? built : [built]).flatMap(result => result.output)
    .find(result => result.type === 'asset' && result.fileName.endsWith('/compiled.html'))
  assert.ok(html, 'the production build must include its standalone HTML entry')
  for (const disabled of [false, true]) {
    application = await electron.launch({ args: [path.join(root, 'scripts/electron-ui-test-main.cjs')],
      env: { ...process.env, RMS_UI_TEST_DATA_DIR: path.join(temporary, disabled ? 'unsupported' : 'normal'),
        RMS_UI_TEST_URL: pathToFileURL(path.join(output, html.fileName)).href + (disabled ? '?no-webgl=1' : '') } })
    const page = await application.firstWindow()
    await page.waitForFunction(() => document.body.dataset.completed === 'true', null, { timeout: 20000 })
    const result = await page.evaluate(() => window.compiledMotionResult)
    results.push({ disabled, ...result, rendererFeatures: await application.evaluate(({ app }) => app.getGPUFeatureStatus()) })
    await fs.mkdir(path.join(root, '.mjai-runtime'), { recursive: true })
    await fs.writeFile(path.join(root, '.mjai-runtime/built-discard-coverage.json'), JSON.stringify(results, null, 2))
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.equal(result.protocol, 'file:')
    assert.equal(result.sourceProtocol, 'file:')
    assert.equal(result.fallback, disabled, 'unsupported WebGL remains sharp; capable packaged worker must actually render')
    assert.equal(result.owner.defaultStarted, true, 'production motion owner starts without a DEV trial toggle')
    assert.equal(result.owner.supported, !disabled)
    assert.equal(await page.locator('.discard-motion-surface').count(), 0, 'compiled worker/surface retires')
    await application.close(); application = null
  }
  await fs.mkdir(path.join(root, '.mjai-runtime'), { recursive: true })
  await fs.writeFile(path.join(root, '.mjai-runtime/built-discard-coverage.json'), JSON.stringify(results, null, 2))
  console.log(`Compiled file-origin coverage and unavailable worker-WebGL2 fallback passed: ${JSON.stringify(results)}`)
} finally {
  try { await application?.close() } finally {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()))
    assert.ok(path.basename(temporary).startsWith('rms-built-coverage-'))
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}
