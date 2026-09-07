import assert from 'node:assert/strict'

// Uses the existing isolated renderer and its in-memory settings bridge.
export async function checkWorkspaceDock(page) {
  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.evaluate(() => {
    const vm = window.analysisCheck.vm
    vm.settings.display.workspaceLayout = {
      ...vm.workspaceLayout, analysisVisible: false, consoleVisible: true,
      layout: { type: 'split', direction: 'horizontal', weights: [3, 1], children: [
        { type: 'item', id: 'table' }, { type: 'item', id: 'console' },
      ] },
    }
  })
  const consoleLeaf = page.locator('[data-dock-target="console"]')
  const handle = consoleLeaf.locator('.dock-module-drag-handle')
  await handle.waitFor({ state: 'visible' })
  const initial = await page.evaluate(() => JSON.stringify(window.analysisCheck.vm.workspaceLayout.layout))
  const bounds = await handle.boundingBox()
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  assert.equal(await consoleLeaf.count(), 1, 'press alone retains the source panel')
  await page.mouse.move(x + 1, y + 1)
  assert.equal(await consoleLeaf.count(), 1, 'sub-threshold movement retains the source panel')
  await page.mouse.move(x - 30, y + 40)
  await consoleLeaf.waitFor({ state: 'detached' })
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await consoleLeaf.waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => JSON.stringify(window.analysisCheck.vm.workspaceLayout.layout)), initial,
    'canceling drag leaves the stored layout unchanged')

  const separator = page.locator('.dock-layout-resizer').first()
  const separatorBounds = await separator.boundingBox()
  const sx = separatorBounds.x + separatorBounds.width / 2
  const sy = separatorBounds.y + separatorBounds.height / 2
  const widthBefore = (await consoleLeaf.boundingBox()).width
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx - 70, sy)
  await page.waitForFunction(width => document.querySelector('[data-dock-target="console"]').getBoundingClientRect().width > width + 30, widthBefore)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  assert.equal(await page.evaluate(() => JSON.stringify(window.analysisCheck.vm.workspaceLayout.layout)), initial,
    'canceling resize restores the initial split')
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(sx - 70, sy)
  await page.mouse.up()
  await page.waitForFunction(width => document.querySelector('[data-dock-target="console"]').getBoundingClientRect().width > width + 30, widthBefore)

  await page.evaluate(() => {
    const vm = window.analysisCheck.vm
    vm.settings.display.workspaceLayout = {
      ...vm.workspaceLayout,
      layout: { type: 'split', direction: 'vertical', weights: [3, 1], children: [
        { type: 'item', id: 'table' }, { type: 'item', id: 'console' },
      ] },
    }
  })
  await page.waitForFunction(() => document.querySelector('.dock-layout-split.is-vertical'))
  const verticalSeparator = page.locator('.dock-layout-resizer.is-vertical').first()
  const verticalBounds = await verticalSeparator.boundingBox()
  const vx = verticalBounds.x + verticalBounds.width / 2
  const vy = verticalBounds.y + verticalBounds.height / 2
  const heightBefore = (await consoleLeaf.boundingBox()).height
  await page.mouse.move(vx, vy)
  await page.mouse.down()
  await page.mouse.move(vx, vy - 60)
  await page.mouse.up()
  await page.waitForFunction(height => document.querySelector('[data-dock-target="console"]').getBoundingClientRect().height > height + 30, heightBefore)

  const nextHandle = await handle.boundingBox()
  await page.mouse.move(nextHandle.x + 20, nextHandle.y + 8)
  await page.mouse.down()
  await page.mouse.move(nextHandle.x - 30, nextHandle.y + 40)
  await consoleLeaf.waitFor({ state: 'detached' })
  const table = await page.locator('[data-dock-target="table"]').boundingBox()
  await page.mouse.move(table.x + 3, table.y + table.height / 2)
  await page.locator('.dock-drop-indicator').waitFor({ state: 'visible' })
  await page.mouse.up()
  await consoleLeaf.waitFor({ state: 'visible' })
  const afterConsole = await consoleLeaf.boundingBox()
  const afterTable = await page.locator('[data-dock-target="table"]').boundingBox()
  assert.ok(afterConsole.x < afterTable.x, 'dropping at the left edge moves console left of table')
  const after = await page.evaluate(() => JSON.stringify(window.analysisCheck.vm.workspaceLayout.layout))
  await page.mouse.move(600, 500)
  assert.equal(await page.evaluate(() => JSON.stringify(window.analysisCheck.vm.workspaceLayout.layout)), after,
    'completed interaction no longer responds to pointer movement')
}
