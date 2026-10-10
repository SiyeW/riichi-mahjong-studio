import assert from 'node:assert/strict'

export async function checkReplayWorkflow(page) {
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
        overflow: tooltip.scrollWidth - tooltip.clientWidth }
    })
    assert.notEqual(geometry.transform, 'none', 'the in-place reveal follows the rotated seat')
    assert.ok(Math.abs(geometry.originalGlyph.x - geometry.revealedGlyph.x) < 1
      && Math.abs(geometry.originalGlyph.y - geometry.revealedGlyph.y) < 1,
    `revealing a name preserves its glyph origin: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.overflow <= 1, `long names wrap rather than scroll: ${JSON.stringify(geometry)}`)
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
