import assert from 'node:assert/strict'

export async function checkToolbarWindowToggles(page) {
  const toolbar = page.locator('.toolbar')
  const wall = toolbar.getByRole('button', { name: '牌山', exact: true })
  const engine = toolbar.getByRole('button', { name: '引擎', exact: true })
  const check = async (button, selector, visible) => {
    assert.equal(await button.getAttribute('aria-pressed'), String(visible))
    assert.equal(await button.evaluate(node => node.classList.contains('active')), visible)
    assert.equal(await page.locator(selector).count(), visible ? 1 : 0)
  }
  const originalReads = await page.evaluate(() => window.analysisCheck.wallReads)
  try {
    await check(wall, '.wall-window', false)
    await check(engine, '.engine-window', false)
    // Closing while data is in flight must retire the existing owner, not
    // merely recolor the trigger or allow a late response to reopen the window.
    await page.evaluate(() => {
      window.toolbarWallRead = window.studioAPI.getWallView
      window.studioAPI.getWallView = () => new Promise(resolve => { window.finishToolbarWallRead = resolve })
    })
    await wall.click()
    await check(wall, '.wall-window', true)
    await wall.click()
    await check(wall, '.wall-window', false)
    await page.evaluate(async () => {
      window.finishToolbarWallRead({ tiles: [], complete: true })
      window.studioAPI.getWallView = window.toolbarWallRead
      await new Promise(resolve => requestAnimationFrame(resolve))
    })
    await check(wall, '.wall-window', false)

    await wall.click()
    await page.locator('.wall-window .wall-grid').waitFor()
    await engine.click()
    await check(engine, '.engine-window', true)
    await check(wall, '.wall-window', true)
    const colors = await toolbar.evaluate(async toolbar => {
      await Promise.all(toolbar.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})))
      const button = name => [...toolbar.querySelectorAll('button')].find(node => node.textContent.trim() === name)
      return ['牌山', '引擎', '控制台'].map(name => getComputedStyle(button(name)).backgroundColor)
    })
    assert.equal(colors[0], colors[2], 'wall reuses the console active color')
    assert.equal(colors[1], colors[2], 'engine reuses the console active color')
    await page.locator('.engine-window .floating-panel-close').click()
    await check(engine, '.engine-window', false)
    await check(wall, '.wall-window', true)
    await engine.click()
    await engine.click()
    await check(engine, '.engine-window', false)
    await page.locator('.wall-window .floating-panel-close').click()
    await check(wall, '.wall-window', false)
    await wall.click()
    await wall.click()
    await check(wall, '.wall-window', false)
  } finally {
    await page.evaluate(reads => {
      if (window.toolbarWallRead) window.studioAPI.getWallView = window.toolbarWallRead
      delete window.toolbarWallRead
      delete window.finishToolbarWallRead
      window.analysisCheck.vm.closeWallView(true)
      window.analysisCheck.vm.closeEngineWindow()
      window.analysisCheck.wallReads = reads
    }, originalReads)
  }
  console.log('Toolbar windows: shared active color, independent toggle/close and pending wall retirement passed.')
}
