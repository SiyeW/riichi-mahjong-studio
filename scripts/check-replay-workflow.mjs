import assert from 'node:assert/strict'
import fs from 'node:fs'
import zlib from 'node:zlib'

function populatedTable() {
  const record = JSON.parse(zlib.gunzipSync(fs.readFileSync(
    new URL('../examples/example-record.mjstudio', import.meta.url),
  )).toString('utf8'))
  const table = Object.values(record.game.nodes).map(node => node.snapshot).filter(Boolean)
    .filter(table => table.melds.some(melds => melds.length) && table.rivers.every(river => river.length >= 6))
    .sort((a, b) => b.rivers.flat().length - a.rivers.flat().length)[0]
  return table && { ...table, wallRemaining: Math.max(0, table.wallState.liveEnd - table.drawIndex) }
}

export async function checkReplayWorkflow(page) {
  const table = populatedTable()
  assert.ok(table, 'visual fixture includes real discards and melds')
  await page.evaluate(table => { window.analysisCheck.vm.gameView.table = table }, table)
  await page.evaluate(() => {
    const check = window.analysisCheck
    check.nameWrites = []
    check.vm.gameView.playerNames = ['Short', ...Array(3).fill('Very long model name with g descenders and multiple words for overflow')]
    window.studioAPI.setPlayerName = async (seat, name) => {
      check.nameWrites.push([seat, name])
      return { changed: true, seat, name: name.trim() }
    }
  })
  const names = page.locator('.player-name-button')
  assert.equal(await names.count(), 4, 'all four stable seats have a name editor')
  assert.ok(await names.evaluateAll(buttons => buttons.every(button =>
    getComputedStyle(button).fontSize === getComputedStyle(document.querySelector('.gi-riichi-bet')).fontSize)),
  'player names use the same font size as the riichi deduction')
  await names.first().hover()
  assert.equal(await page.locator('.ui-hover-tooltip.is-inline-reveal').count(), 0, 'untruncated names have no reveal')
  for (let index = 1; index < 4; index++) {
    await names.nth(index).hover()
    const reveal = page.locator('.ui-hover-tooltip.is-inline-reveal')
    await reveal.waitFor({ state: 'visible' })
    const geometry = await names.nth(index).evaluate(button => {
      const target = button.querySelector('.player-name-text')
      const tooltip = document.querySelector('.ui-hover-tooltip.is-inline-reveal')
      const anchor = target.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents(tooltip)
      const glyphs = range.getBoundingClientRect()
      const firstGlyph = element => {
        const range = document.createRange()
        range.setStart(element.firstChild, 0)
        range.setEnd(element.firstChild, 1)
        const rect = range.getBoundingClientRect()
        return { x: rect.x, y: rect.y }
      }
      return { anchor: { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height },
        glyphs: { x: glyphs.x, y: glyphs.y, width: glyphs.width, height: glyphs.height },
        transform: getComputedStyle(tooltip).transform,
        originalGlyph: firstGlyph(target), revealedGlyph: firstGlyph(tooltip),
        overflow: tooltip.scrollWidth - tooltip.clientWidth,
        background: getComputedStyle(tooltip).backgroundColor,
        tableBackground: getComputedStyle(button.closest('.table-player-name')).backgroundColor }
    })
    assert.ok(Math.abs(geometry.originalGlyph.x - geometry.revealedGlyph.x) < 1
      && Math.abs(geometry.originalGlyph.y - geometry.revealedGlyph.y) < 1,
    `revealing a name preserves its glyph origin: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.overflow <= 1, `long names wrap rather than scroll: ${JSON.stringify(geometry)}`)
    assert.equal(geometry.background, geometry.tableBackground, 'reveals use the dark table surface')
    if (process.env.RMS_UI_REPLAY_SCREENSHOT && index === 2) {
      await page.locator('.grid-main').screenshot({
        path: process.env.RMS_UI_REPLAY_SCREENSHOT.replace(/\.png$/, '-reveal.png'),
      })
    }
  }
  await names.first().click()
  const input = page.locator('.player-name-input')
  await input.fill('Edited model g')
  await input.press('Enter')
  await page.waitForFunction(() => window.analysisCheck.vm.gameView.playerNames[0] === 'Edited model g')
  assert.deepEqual(await page.evaluate(() => window.analysisCheck.nameWrites), [[0, 'Edited model g']])
  await names.first().click()
  await input.fill('Cancelled name')
  await input.press('Escape')
  assert.equal(await names.first().textContent(), 'Edited model g')
  assert.equal(await page.evaluate(() => window.analysisCheck.nameWrites.length), 1)
  await page.evaluate(() => { window.analysisCheck.vm.status.controlledSeat = 1 })
  assert.equal(await page.locator('[data-player-seat="0"] .player-name-text').textContent(), 'Edited model g',
    'player names belong to actual seats, not screen positions')
  await page.evaluate(() => { window.analysisCheck.vm.status.controlledSeat = 0 })
  assert.equal(await page.locator('.grid-info .player-name-editor').count(), 0,
    'secondary player names never occupy the central score area')
  const crowdedRivers = table.rivers
  await page.evaluate(() => {
    const table = window.analysisCheck.vm.gameView.table
    table.pendingDiscard = null
    table.rivers = table.rivers.map(river => Array.from({ length: 12 }, (_, index) => river[index % river.length]))
  })
  const fullEdgeWidths = await page.locator('.table-player-name').evaluateAll(elements =>
    elements.map(element => element.clientWidth))
  assert.equal(await page.locator('.has-third-river-row').count(), 0)
  for (let seat = 0; seat < 4; seat++) {
    await page.evaluate(seat => { window.analysisCheck.vm.gameView.table.rivers[seat].push('1m') }, seat)
    const clipped = page.locator(`[data-player-seat="${seat}"]`)
    assert.ok(await clipped.evaluate(element => element.classList.contains('has-third-river-row')),
      'the first actual third-row tile limits only its own player name')
    assert.ok(await clipped.evaluate(element => element.clientWidth) < fullEdgeWidths[seat] / 2)
  }
  await page.evaluate(rivers => { window.analysisCheck.vm.gameView.table.rivers = rivers }, crowdedRivers)
  for (let controlled = 0; controlled < 4; controlled++) {
    await page.evaluate(seat => { window.analysisCheck.vm.status.controlledSeat = seat }, controlled)
    const corners = await page.locator('.table-player-name').evaluateAll(elements => elements.map(element => ({
      seat: Number(element.dataset.playerSeat),
      position: [...element.classList].find(name => name.startsWith('table-player-name--')).split('--')[1],
      constrained: element.classList.contains('has-third-river-row'),
    })))
    assert.deepEqual(corners, ['south', 'east', 'north', 'west'].map((position, offset) => {
      const seat = (controlled + offset) % 4
      return { seat, position, constrained: crowdedRivers[seat].length > 12 }
    }), 'rotating viewpoints preserves the actual player and its own river constraint')
  }
  await page.evaluate(() => { window.analysisCheck.vm.status.controlledSeat = 0 })
  const originalViewport = page.viewportSize()
  for (const viewport of [{ width: 1400, height: 1000 }, { width: 1000, height: 740 }]) {
    await page.setViewportSize(viewport)
    await page.waitForTimeout(200)
    const bounds = await page.locator('.table-player-names').evaluate(overlay => {
      const rect = element => {
        const { left, top, right, bottom } = element.getBoundingClientRect()
        return { left, top, right, bottom }
      }
      return { square: rect(overlay), names: [...overlay.children].map(element => ({
        position: element.className.split('--')[1], bounds: rect(element),
      })), riverTiles: [...document.querySelectorAll('.grid-discard .tileDiv')].map(rect) }
    })
    assert.ok(bounds.riverTiles.length >= 24, 'the layout check actually sees the populated rivers')
    for (const { position, bounds: name } of bounds.names) {
      assert.ok(name.left >= bounds.square.left && name.top >= bounds.square.top
        && name.right <= bounds.square.right + 1 && name.bottom <= bounds.square.bottom + 1,
      `name remains inside its corner at ${viewport.width}px: ${JSON.stringify({ position, bounds })}`)
      for (const tile of bounds.riverTiles) {
        assert.ok(name.right <= tile.left || tile.right <= name.left
          || name.bottom <= tile.top || tile.bottom <= name.top, 'names do not cover discards')
      }
    }
    if (process.env.RMS_UI_REPLAY_SCREENSHOT) {
      await page.mouse.move(0, 0)
      await page.locator('.grid-main').screenshot({
        path: process.env.RMS_UI_REPLAY_SCREENSHOT.replace(/\.png$/, `-${viewport.width}.png`),
      })
    }
  }
  await page.setViewportSize(originalViewport)
  if (process.env.RMS_UI_REPLAY_SCREENSHOT) {
    await page.mouse.move(0, 0)
    await page.locator('.grid-main').screenshot({ path: process.env.RMS_UI_REPLAY_SCREENSHOT })
  }
  await page.evaluate(() => {
    const check = window.analysisCheck
    check.vm.showRecordImportPanel = true
    window.studioAPI.selectRecordImportFile = async () => 'D:\\arena\\match.json.gz'
    window.studioAPI.importReplayFile = request => {
      check.fileImport = request
      return new Promise((resolve, reject) => { check.rejectFileImport = reject })
    }
  })
  await page.locator('.record-import-file button').first().click()
  await page.locator('.record-import-file-name').waitFor()
  assert.equal(await page.locator('.record-import-modal textarea').isDisabled(), true)
  await page.locator('.record-import-modal button[type="submit"]').click()
  await page.waitForFunction(() => window.analysisCheck.fileImport)
  assert.deepEqual(await page.evaluate(() => window.analysisCheck.fileImport), {
    path: 'D:\\arena\\match.json.gz', reconstructWalls: false, seed: '',
  })
  await page.evaluate(() => window.analysisCheck.rejectFileImport(new Error('fixture invalid MJAI')))
  await page.waitForFunction(() => document.querySelector('.record-import-error')?.textContent.includes('fixture invalid MJAI'))
  assert.equal(await names.first().textContent(), 'Edited model g', 'failed import retains the old record and its names')
  await page.evaluate(() => {
    const check = window.analysisCheck
    window.studioAPI.importReplayFile = async () => ({
      state: JSON.parse(JSON.stringify(check.vm.status)), recordDirty: true,
      view: { ...JSON.parse(JSON.stringify(check.vm.gameView)), gameId: 'imported-game', playerNames: ['Mortal', 'Flash', 'Pro', 'Reference'] },
    })
  })
  await page.locator('.record-import-modal button[type="submit"]').click()
  await page.locator('.record-import-modal').waitFor({ state: 'detached' })
  assert.deepEqual(await page.evaluate(() => window.analysisCheck.vm.gameView.playerNames), ['Mortal', 'Flash', 'Pro', 'Reference'])
  await page.evaluate(() => window.analysisCheck.vm.closeRecordImportPanel())
}
