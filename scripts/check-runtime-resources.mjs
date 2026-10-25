import assert from 'node:assert/strict'
import path from 'node:path'

export async function checkRuntimeResources(page) {
  const status = page.locator('.footer-memory-status')
  const detail = page.locator('#runtime-memory-detail')
  await page.waitForFunction(() => document.querySelectorAll('[data-resource-group]').length === 3)
  const original = await page.evaluate(() => {
    window.originalResourceReader = window.studioAPI.getRuntimeMetrics
    const state = document.querySelector('#app').__vue_app__._instance.setupState
    window.resourceSample = state.runtimeMetrics
    window.studioAPI.getRuntimeMetrics = async () => window.resourceSample
    return state.runtimeMetrics
  })
  const sample = async metrics => {
    await page.evaluate(metrics => {
      window.resourceSample = metrics
      document.querySelector('#app').__vue_app__._instance.setupState.runtimeMetrics = metrics
    }, metrics)
  }
  const row = (group, id) => page.locator(`[data-resource-group="${group}"] [data-resource-row="${id}"]`)
  const fraction = (group, id) => row(group, id).locator('.resource-track > span')
    .evaluate(fill => Number(getComputedStyle(fill).transform.match(/^matrix\(([^,]+)/)[1]))
  try {
    assert.equal(await status.locator(':scope > .resource-item').count(), 2, 'only application/system text stays in the footer')
    assert.equal(await status.locator(':scope > .resource-item .resource-track').count(), 0)
    assert.ok(!(await status.locator(':scope > .resource-item').allTextContents()).join(' ').includes('缓存'))
    assert.equal(await detail.isVisible(), false, 'details start hidden')
    await status.hover()
    await detail.waitFor({ state: 'visible' })
    assert.deepEqual(await detail.locator('[data-resource-group]').evaluateAll(elements => elements.map(element => element.dataset.resourceGroup)),
      ['system', 'application', 'cache'], 'details follow system, application, then cache')
    assert.equal(await detail.locator('[data-resource-group="system"] > .resource-note').count(), 0, 'normal system details do not add an accounting disclaimer')
    assert.equal(await fraction('application', 'electron'), 0.64, 'program breakdown is relative to program total, not system RAM')
    assert.equal(await fraction('system', 'used'), 0.5)
    assert.ok(Math.abs(await fraction('system', 'application') - 800 / 16384) < .000001, 'application residency is visible against the system reference')
    assert.equal(await fraction('cache', 'resident'), 0.5)
    const tracks = await detail.locator('.resource-track').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    }))
    assert.ok(tracks.length === 10 && tracks.every(track => track.height > 0
      && Math.abs(track.width - tracks[0].width) < 0.1 && track.height === tracks[0].height), 'all detail bars share the same geometry')
    const trigger = await status.boundingBox()
    const card = await detail.boundingBox()
    await page.mouse.move(trigger.x + trigger.width / 2, (trigger.y + card.y + card.height) / 2)
    assert.equal(await detail.isVisible(), true, 'the mouse can cross the gap to the scrollable details')
    await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2)
    assert.equal(await detail.isVisible(), true)
    if (process.env.RMS_UI_RESOURCE_SCREENSHOT) {
      await detail.screenshot({ path: path.resolve(process.env.RMS_UI_RESOURCE_SCREENSHOT) })
    }

    await sample({ ...original, applicationBytes: 1.05 * 1024 ** 3,
      systemAvailableBytes: 634 * 1024 ** 2, systemTotalBytes: 16 * 1024 ** 3 })
    assert.ok((await status.locator(':scope > .resource-item').nth(0).innerText()).includes('1.05 GB'))
    assert.ok((await status.locator(':scope > .resource-item').nth(1).innerText()).includes('634 MB'))
    assert.ok(Math.abs(await fraction('system', 'available') - 634 / 16384) < 0.000001)
    await sample({ ...original, recordCache: { ...original.recordCache,
      residentBytes: 96 * 1024 ** 2, protectedBytes: 80 * 1024 ** 2, encodedPendingBytes: 160 * 1024 ** 2,
      protectedOvershootBytes: 64 * 1024 ** 2, pendingResults: 3, queuedWrites: 4,
      error: 'Test recovery write failure' } })
    assert.equal(await status.locator(':scope > .resource-error').count(), 1, 'important faults remain visible outside the details')
    assert.equal(await fraction('cache', 'resident'), 0.6)
    assert.equal(await fraction('cache', 'pending'), 1)
    assert.ok((await page.locator('[data-resource-group="cache"]').innerText()).includes('160 MB'))
    assert.ok((await detail.locator('.resource-warning').innerText()).includes('Test recovery write failure'))

    for (const language of ['zh-CN', 'ja-JP', 'en-US']) {
      for (const [width, height, scale] of [[1120, 1000, 1], [800, 600, 1.75], [1800, 1000, 1]]) {
        await page.setViewportSize({ width, height })
        await page.evaluate(({ language, scale }) => {
          window.analysisCheck.vm.settings.display.language = language
          window.analysisCheck.vm.settings.display.uiScale = scale
        }, { language, scale })
        await status.hover()
        const geometry = await detail.evaluate(element => {
          const rect = element.getBoundingClientRect()
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
            width: innerWidth, height: innerHeight, client: element.clientWidth, scroll: element.scrollWidth }
        })
        assert.ok(geometry.left >= 0 && geometry.right <= geometry.width + 1 && geometry.top >= 0 && geometry.bottom <= geometry.height,
          `resource details stay within the ${width}×${height} viewport in ${language}`)
        assert.ok(geometry.scroll <= geometry.client + 1, `resource text wraps instead of overflowing in ${language}`)
        const footer = await page.locator('.footer').evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }))
        assert.ok(footer.scroll <= footer.client + 1, `footer remains compact in ${language}`)
        if (height === 600) {
          const card = await detail.boundingBox()
          await page.mouse.move(card.x + card.width / 2, card.y + card.height / 2)
          await page.mouse.wheel(0, 500)
          await page.waitForFunction(() => document.querySelector('#runtime-memory-detail').scrollTop > 0)
          await detail.evaluate(element => { element.scrollTop = 0 })
          await page.mouse.move(1, 1)
          await page.keyboard.press('Tab')
          await status.focus()
          assert.equal(await detail.isVisible(), true, 'keyboard focus reveals the same details')
          await page.keyboard.press('End')
          assert.ok(await detail.evaluate(element => element.scrollTop > 0), 'long details can be scrolled from the keyboard')
          await page.keyboard.press('Home')
          assert.equal(await detail.evaluate(element => element.scrollTop), 0)
          await status.evaluate(element => element.blur())
        }
      }
    }
    await sample(null)
    await status.hover()
    assert.equal(await detail.locator('.resource-track').count(), 0, 'unavailable samples never invent filled meters')
    assert.ok((await status.locator(':scope > .resource-item').allTextContents()).every(text => text.includes('—')))
    await sample({ ...original, recordCache: null })
    assert.equal(await detail.locator('[data-resource-group]').count(), 2)
    await page.mouse.move(1, 1)
    await status.click()
    await page.mouse.move(1, 1)
    assert.equal(await detail.isVisible(), false, 'a mouse click does not leave the hover card stuck open')
  } finally {
    await sample(original)
    await page.evaluate(() => {
      window.studioAPI.getRuntimeMetrics = window.originalResourceReader
      delete window.originalResourceReader
      delete window.resourceSample
      window.analysisCheck.vm.settings.display.language = 'zh-CN'
      window.analysisCheck.vm.settings.display.uiScale = 1
    })
    await page.setViewportSize({ width: 1400, height: 1000 })
    await page.mouse.move(1, 1)
    await status.evaluate(element => element.blur())
  }
}
