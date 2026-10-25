import assert from 'node:assert/strict'

export async function checkRendererRecovery(page) {
  await page.locator('[data-player-seat="0"] .player-name-button').click()
  await page.locator('.player-name-input').fill('Unsaved name')
  await page.setViewportSize({ width: 320, height: 700 })
  await page.evaluate(() => {
    const app = document.querySelector('#app').__vue_app__
    const check = window.analysisCheck
    check.recoveryWrites = []
    window.studioAPI.setPlayerName = async (seat, name) => {
      check.recoveryWrites.push([seat, name])
      throw new Error('fixture pending edit failed')
    }
    // Inject through Vue's actual error boundary, then remove its root. The
    // recovery surface and pending-edit owner must survive both events.
    app.config.errorHandler(new Error('fixture render failure'), null, 'render function')
    app.unmount()
  })
  const surface = page.locator('.renderer-recovery')
  await surface.waitFor({ state: 'visible' })
  assert.equal(await page.locator('#app').getAttribute('inert'), '')
  assert.equal(await surface.locator('[role="alertdialog"]').count(), 1)
  assert.ok((await surface.textContent()).includes('fixture render failure'))
  assert.equal(await page.locator('#app > *').count(), 0, 'recovery is independent of the unmounted Vue tree')
  const button = surface.locator('button')
  await button.click()
  await page.waitForFunction(() => document.querySelector('.renderer-recovery [role="status"]')
    ?.textContent.includes('fixture pending edit failed'))
  assert.equal(await button.isEnabled(), true, 'failed edits keep the page and allow retry')
  assert.deepEqual(await page.evaluate(() => window.analysisCheck.recoveryWrites.at(-1)), [0, 'Unsaved name'])
  const geometry = await surface.locator('[role="alertdialog"]').evaluate(panel => ({
    left: panel.getBoundingClientRect().left,
    right: panel.getBoundingClientRect().right,
    viewport: window.innerWidth,
    overflow: panel.scrollWidth > panel.clientWidth,
  }))
  assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport)
  assert.equal(geometry.overflow, false)
  await page.evaluate(() => {
    window.studioAPI.setPlayerName = async (_seat, name) => ({ name })
  })
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    button.click(),
  ])
  await page.waitForFunction(() => window.analysisCheck?.vm.tileArtworkReady)
  assert.equal(await surface.count(), 0, 'successful flush reloads a working renderer')
  assert.equal(await page.locator('#app').getAttribute('inert'), null)
}
