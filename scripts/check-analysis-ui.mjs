import assert from 'node:assert/strict'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

// Real renderer, isolated bridge: no user records, engine processes or settings.
const root = path.resolve(import.meta.dirname, '..')
const server = await createServer({ root, mode: 'ui-test', server: { host: '127.0.0.1', port: 0, strictPort: false } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
  await page.addInitScript(() => {
    window.setupRmsAnalysisTest = vm => {
      window.analysisCheck = {
        vm, reads: 0, epoch: 0,
        result(expectedValue = 1) {
          return {
            status: 'ready',
            context: { gameId: vm.gameView.gameId, nodeId: vm.gameView.currentNodeId, seat: vm.status.controlledSeat, inputMode: 'public', cacheKey: 'test-engine', cacheEpoch: this.epoch },
            outputs: {
              'wall-tile-count': { tiles: { '1m': { expectedValue, distribution: [{ value: 0, probability: 0.25 }, { value: 1, probability: 0.75 }] } } },
              'opponent-dora-count': {
                players: [1, 2, 3].map((seat, index) => ({
                  seat,
                  prediction: {
                    expectedValue: 0.7 + (index * 0.1),
                    distribution: [0, 1, 2, 3, 4, 5, 6, '7+'].map((value, valueIndex) => ({
                      value,
                      probability: Math.max(0.01, 0.32 - (valueIndex * 0.038) + (index * 0.004)),
                    })),
                  },
                })),
              },
              'opponent-score': {
                players: [1, 2, 3].map((seat, index) => ({
                  seat,
                  prediction: {
                    expectedValue: 6800 + (index * 450),
                    distribution: [1000, 2000, 3900, 5800, 7700, 8000, 12000, 16000, 24000, 32000, 48000, 64000, 96000].map((value, valueIndex) => ({
                      value,
                      probability: Math.max(0.01, 0.16 - Math.abs(valueIndex - 5 - index) * 0.018),
                    })),
                  },
                })),
              },
              'opponent-deal-in-probability': {
                players: [1, 2, 3].map((seat, sourceIndex) => ({
                  seat,
                  tiles: Object.fromEntries(
                    ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p', '1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s', '1z', '2z', '3z', '4z', '5z', '6z', '7z']
                      .map((tile, tileIndex) => [tile, ((tileIndex + sourceIndex) % 5 + 1) * 0.025]),
                  ),
                })),
              },
            },
          }
        },
        publish(result = this.result()) {
          vm.handlePythonEvent({ type: 'opponent_analysis_ready', opponentAnalysis: result, gameId: result.context.gameId, nodeId: result.context.nodeId, seat: result.context.seat })
        },
      }
      const check = window.analysisCheck
      if (vm.showPerceptualColorDebugger !== false) throw new Error('F8 debugger must start hidden')
      window.trainerAPI = {
        getSettings: async () => JSON.parse(JSON.stringify(vm.settings)),
        getStatus: async () => JSON.parse(JSON.stringify(vm.status)),
        restoreStartupRecovery: async () => null,
        getRecordDirty: async () => false,
        getShanten: async () => { check.reads++; return check.result() },
        setAnalysisVisibility: async () => ({ state: JSON.parse(JSON.stringify(vm.status)) }),
        saveSettings: async settings => settings,
        toggleVisibleHands: async () => ({ ...JSON.parse(JSON.stringify(vm.status)), visibleHands: !vm.status.visibleHands }),
        getGameView: async () => ({ state: JSON.parse(JSON.stringify(vm.status)), view: JSON.parse(JSON.stringify(vm.gameView)) }),
        clearAnalysisCaches: async () => {
          check.epoch++
          return { state: JSON.parse(JSON.stringify(vm.status)), cleared: { decisionEntries: 0, opponentEntries: 1, comparisons: 0, treeRevision: 1 } }
        },
      }
      vm.status.mode = 'research'
      vm.status.gameLoaded = true
      vm.gameView.gameId = 'ui-test-game'
      vm.gameView.currentNodeId = 'node-1'
      vm.gameView.table = {
        bakaze: 'E', kyoku: 1, honba: 0, kyotaku: 0, dealer: 0,
        currentActor: 0, phase: 'draw', turn: 1, drawIndex: 1, wallRemaining: 69,
        doraIndicators: ['1m'], scores: [25000, 25000, 25000, 25000],
        hands: [[], [], [], []], rivers: [[], [], [], []], melds: [[], [], [], []],
        pendingDiscard: null, reactionWindow: null,
      }
      vm.settings.display.workspaceLayout = {
        ...vm.workspaceLayout, analysisVisible: true, consoleVisible: true,
        layout: {
          type: 'split', direction: 'horizontal', weights: [2, 1, 1],
          children: [
            { type: 'item', id: 'table' }, { type: 'item', id: 'analysis-counts' },
            { type: 'split', direction: 'vertical', weights: [1, 1, 1, 1],
              children: ['console', 'analysis-opponents', 'analysis-game', 'analysis-risk'].map(id => ({ type: 'item', id })) },
          ],
        },
        analysisPanels: { opponents: false, game: false, risk: false, counts: true },
      }
    }
  })
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => window.analysisCheck?.vm.tileArtworkReady)
  assert.equal(await page.evaluate(() => window.analysisCheck.vm.bootstrapError), '', 'fixture boots through the normal desktop bridge path')
  assert.equal(
    await page.locator('.auto-analysis-progress small').evaluate(element => getComputedStyle(element).opacity),
    '1',
    'auto-analysis progress details stay visible without hover',
  )
  const tooltip = page.locator('.count-prediction-tooltip')
  const target = () => page.locator('.analysis-count-source-row').nth(3).locator('.analysis-count-source-tile').first()
  await target().waitFor().catch(async error => {
    console.error(await page.locator('body').innerText())
    console.error(await page.evaluate(() => ({ reads: window.analysisCheck.reads, layout: window.analysisCheck.vm.workspaceLayout, result: window.analysisCheck.vm.gameView.opponentAnalysis })))
    throw error
  })
  await page.waitForTimeout(300)
  const readCount = () => page.evaluate(() => window.analysisCheck.reads)
  const baselineReads = await readCount()
  assert.ok(baselineReads > 0, 'opening reads the current result')
  await target().hover()
  await tooltip.waitFor({ state: 'visible' })
  await page.waitForTimeout(6500)
  assert.equal(await readCount(), baselineReads, 'idle analysis must not poll')
  assert.equal(await tooltip.isVisible(), true, 'hover survives multiple former polling intervals')

  await page.evaluate(() => {
    window.originalCountTooltip = document.querySelector('.count-prediction-tooltip')
    window.analysisCheck.publish(window.analysisCheck.result(2.5))
  })
  await page.waitForFunction(() => document.querySelector('.count-tooltip-estimate')?.textContent.includes('2.50'))
  assert.equal(await page.evaluate(() => document.querySelector('.count-prediction-tooltip') === window.originalCountTooltip), true, 'refresh updates the existing tooltip')
  // Scroll a separate element, not an ancestor of the hovered tile.
  await page.evaluate(() => { const el = document.createElement('div'); document.body.append(el); el.dispatchEvent(new Event('scroll')); el.remove() })
  assert.equal(await tooltip.isVisible(), true)

  // An older one-shot reply cannot replace a result delivered while it waits.
  await page.evaluate(() => {
    const check = window.analysisCheck
    const read = window.trainerAPI.getShanten
    window.trainerAPI.getShanten = () => new Promise(resolve => { check.resolveRead = resolve })
    check.pendingRead = check.vm.fetchShantenOnce()
    window.trainerAPI.getShanten = read
    check.publish(check.result(3.5))
    check.resolveRead(check.result(0.5))
  })
  await page.evaluate(() => window.analysisCheck.pendingRead)
  assert.equal(await page.evaluate(() => window.analysisCheck.vm.gameView.opponentAnalysis.outputs['wall-tile-count'].tiles['1m'].expectedValue), 3.5)

  // Both layout modes share the same live tooltip lifecycle.
  await page.mouse.move(0, 0)
  await page.evaluate(() => { window.analysisCheck.vm.analysisCountLayout = 'tile-groups' })
  await tooltip.waitFor({ state: 'detached' })
  await page.locator('.analysis-count-tile').first().locator('.source-wall').hover()
  await tooltip.waitFor({ state: 'visible' })
  await page.evaluate(() => window.analysisCheck.publish(window.analysisCheck.result(1.75)))
  await page.waitForFunction(() => document.querySelector('.count-tooltip-estimate')?.textContent.includes('1.75'))
  await page.mouse.move(0, 0)
  await page.evaluate(() => { window.analysisCheck.vm.analysisCountLayout = 'source-rows' })
  await target().hover()
  await tooltip.waitFor({ state: 'visible' })

  // Navigation performs one new read and dismisses the previous position's hover.
  const beforeNavigation = await readCount()
  await page.evaluate(() => { window.analysisCheck.vm.gameView.currentNodeId = 'node-2' })
  await page.waitForFunction(() => window.analysisCheck.vm.gameView.opponentAnalysis.context.nodeId === 'node-2')
  assert.equal(await readCount(), beforeNavigation + 1)
  assert.equal(await tooltip.count(), 0)

  // Closing and reopening restores cached results without starting a timer.
  await page.evaluate(() => window.analysisCheck.vm.toggleAnalysisDock())
  await page.waitForTimeout(100)
  const beforeOpen = await readCount()
  await page.evaluate(() => window.analysisCheck.vm.toggleAnalysisDock())
  await target().waitFor()
  await page.waitForTimeout(200)
  assert.equal(await readCount(), beforeOpen + 1)
  await target().hover()
  await tooltip.waitFor({ state: 'visible' })

  // Clear both the renderer data and hover; an outstanding reply stays discarded.
  await page.evaluate(() => {
    const check = window.analysisCheck
    const read = window.trainerAPI.getShanten
    window.trainerAPI.getShanten = () => new Promise(resolve => { check.resolveRead = resolve })
    check.pendingRead = check.vm.fetchShantenOnce()
    check.oldResult = check.result()
    window.trainerAPI.getShanten = read
  })
  await page.evaluate(() => window.analysisCheck.vm.clearLoadedAnalysisCaches())
  await page.evaluate(async () => { const check = window.analysisCheck; check.resolveRead(check.oldResult); await check.pendingRead })
  assert.equal(await page.evaluate(() => window.analysisCheck.vm.gameView.opponentAnalysis), null)
  assert.equal(await page.evaluate(() => window.analysisCheck.vm.opponentAnalysisIsLoading), false, 'cleared idle panels are empty, not loading forever')
  assert.equal(await tooltip.count(), 0)
  const afterClear = await readCount()
  await page.waitForTimeout(2500)
  assert.equal(await readCount(), afterClear, 'cleared data is not silently requested again')
  assert.equal(await page.evaluate(() => window.analysisCheck.vm.gameView.opponentAnalysis), null)

  // Mouse clicks retain normal focus, but must not pin a hover-only tooltip.
  await page.evaluate(() => {
    window.analysisCheck.vm.gameView.table.hands = Array.from({ length: 4 }, () => Array(13).fill('1m'))
  })
  const handButtons = page.locator('.opponent-hand-toggle')
  const hint = page.locator('[id^="ui-hover-tooltip-"]')
  for (let index = 0; index < 3; index++) {
    const button = handButtons.nth(index)
    const before = await page.evaluate(() => window.analysisCheck.vm.status.visibleHands)
    await button.hover()
    await hint.waitFor({ state: 'visible' })
    await button.click()
    await page.waitForFunction(before => window.analysisCheck.vm.status.visibleHands !== before, before)
    assert.equal(await hint.innerText(), await button.getAttribute('aria-label'))
    await page.mouse.move(0, 0)
    assert.equal(await button.evaluate(el => document.activeElement === el), true)
    assert.equal(await hint.count(), 0, 'a mouse-focused hand toggle must not leave a pinned hint')
    if (index === 0 && process.env.RMS_UI_CHECK_SCREENSHOT) {
      await page.screenshot({ path: process.env.RMS_UI_CHECK_SCREENSHOT })
    }
    await page.evaluate(() => { window.analysisCheck.vm.status.visibleHands = !window.analysisCheck.vm.status.visibleHands })
    assert.equal(await hint.count(), 0, 'a later label update must not revive the dismissed hint')
  }
  // Keyboard users still get focus hints, including after Enter activates the control.
  await page.keyboard.press('Tab')
  await handButtons.first().focus()
  await hint.waitFor({ state: 'visible' })
  await page.keyboard.press('Enter')
  await page.waitForTimeout(100)
  assert.equal(await hint.innerText(), await handButtons.first().getAttribute('aria-label'))
  await handButtons.first().click()
  await page.mouse.move(0, 0)
  assert.equal(await hint.count(), 0, 'switching from keyboard to mouse must not leave a focus hint')
  await page.keyboard.press('Tab')
  await handButtons.first().focus()
  await hint.waitFor({ state: 'visible' })
  await handButtons.first().evaluate(el => el.blur())
  assert.equal(await hint.count(), 0, 'keyboard blur dismisses the hint')

  // Dora and score distributions absorb useful vertical space in the opponent
  // panel, then stop at a restrained maximum instead of becoming tall columns.
  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.evaluate(() => {
    const vm = window.analysisCheck.vm
    window.analysisCheck.publish(window.analysisCheck.result())
    vm.settings.display.workspaceLayout = {
      ...vm.workspaceLayout,
      analysisVisible: true,
      consoleVisible: false,
      layout: {
        type: 'split', direction: 'horizontal', weights: [2, 1],
        children: [{ type: 'item', id: 'table' }, { type: 'item', id: 'analysis-opponents' }],
      },
      analysisPanels: { opponents: true, game: false, risk: false, counts: false },
    }
  })
  const opponentGeometry = async () => page.locator('.analysis-opponent-section').evaluate(section => {
    const dora = section.querySelector('.analysis-dora-distribution')
    const score = section.querySelector('.analysis-score-distribution')
    const grid = section.querySelector('.analysis-opponent-prediction-grid')
    const doraStyle = dora ? getComputedStyle(dora) : null
    const scoreStyle = score ? getComputedStyle(score) : null
    return {
      sectionHeight: section.getBoundingClientRect().height,
      gridHeight: grid?.getBoundingClientRect().height || 0,
      doraHeight: dora?.getBoundingClientRect().height || 0,
      scoreHeight: score?.getBoundingClientRect().height || 0,
      doraMaximum: Number.parseFloat(doraStyle?.maxHeight || '0'),
      scoreMaximum: Number.parseFloat(scoreStyle?.maxHeight || '0'),
    }
  })
  await page.locator('.analysis-dora-distribution').first().waitFor()
  await page.waitForTimeout(100)
  const roomyOpponent = await opponentGeometry()
  assert.ok(roomyOpponent.doraHeight > 36, 'roomy opponent panel grows the dora distribution beyond its former fixed height')
  assert.ok(roomyOpponent.scoreHeight > 26.4, 'roomy opponent panel grows the score distribution beyond its former fixed height')
  assert.ok(roomyOpponent.doraHeight <= roomyOpponent.doraMaximum + 0.6, 'dora distribution respects its visual maximum')
  assert.ok(roomyOpponent.scoreHeight <= roomyOpponent.scoreMaximum + 0.6, 'score distribution respects its visual maximum')
  if (process.env.RMS_OPPONENT_UI_CHECK_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_OPPONENT_UI_CHECK_SCREENSHOT })
  }

  await page.setViewportSize({ width: 1400, height: 430 })
  await page.waitForTimeout(100)
  const shortOpponent = await opponentGeometry()
  assert.ok(shortOpponent.gridHeight < roomyOpponent.gridHeight, 'opponent prediction area follows reductions in allotted height')
  assert.ok(shortOpponent.doraHeight < roomyOpponent.doraHeight, 'dora distribution shrinks with the panel')
  assert.ok(shortOpponent.scoreHeight < roomyOpponent.scoreHeight, 'score distribution shrinks with the panel')
  if (process.env.RMS_OPPONENT_SHORT_UI_CHECK_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_OPPONENT_SHORT_UI_CHECK_SCREENSHOT })
  }

  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.evaluate(() => {
    const result = window.analysisCheck.result()
    for (const outputId of ['opponent-dora-count', 'opponent-score']) {
      for (const player of result.outputs[outputId].players) delete player.prediction.distribution
    }
    window.analysisCheck.publish(result)
  })
  await page.waitForFunction(() => !document.querySelector('.analysis-opponent-prediction-grid')?.className.includes('has-'))
  const scalarOnlyOpponent = await opponentGeometry()
  assert.ok(scalarOnlyOpponent.gridHeight < roomyOpponent.gridHeight, 'scalar-only predictions remain compact instead of creating empty chart space')

  // Deal-in rows fill their allotted width and height while retaining the
  // tile-above, downward-bar, right-scale composition.
  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.evaluate(() => {
    const vm = window.analysisCheck.vm
    window.analysisCheck.publish(window.analysisCheck.result())
    vm.settings.display.workspaceLayout = {
      ...vm.workspaceLayout,
      analysisVisible: true,
      consoleVisible: false,
      layout: {
        type: 'split', direction: 'horizontal', weights: [2, 1],
        children: [{ type: 'item', id: 'table' }, { type: 'item', id: 'analysis-risk' }],
      },
      analysisPanels: { opponents: false, game: false, risk: true, counts: false },
    }
  })
  const riskGrid = page.locator('.analysis-risk-grid')
  await riskGrid.waitFor()
  await page.waitForTimeout(100)
  const riskGeometry = async () => riskGrid.evaluate(grid => {
    const rows = [...grid.querySelectorAll('.analysis-risk-row')]
    const firstTile = grid.querySelector('.analysis-risk-tile')
    const firstFace = grid.querySelector('.analysis-tile-face')
    const firstBars = grid.querySelector('.analysis-risk-bars')
    const scale = grid.querySelector('.analysis-risk-scale')
    const sequence = grid.querySelector('.analysis-tile-sequence')
    const body = grid.closest('.analysis-dock-body')
    return {
      gridWidth: grid.getBoundingClientRect().width,
      gridHeight: grid.getBoundingClientRect().height,
      gridMinHeight: Number.parseFloat(getComputedStyle(grid).minHeight),
      rowWidths: rows.map(row => row.getBoundingClientRect().width),
      rowHeights: rows.map(row => row.getBoundingClientRect().height),
      tileHeight: firstTile?.getBoundingClientRect().height || 0,
      faceHeight: firstFace?.getBoundingClientRect().height || 0,
      faceWidth: firstFace?.getBoundingClientRect().width || 0,
      barsHeight: firstBars?.getBoundingClientRect().height || 0,
      sequenceWidth: sequence?.getBoundingClientRect().width || 0,
      scaleHeight: scale?.getBoundingClientRect().height || 0,
      scaleRight: scale?.getBoundingClientRect().right || 0,
      gridRight: grid.getBoundingClientRect().right,
      bodyClientHeight: body?.clientHeight || 0,
      bodyScrollHeight: body?.scrollHeight || 0,
      rowBorders: rows.map(row => getComputedStyle(row).borderBottomWidth),
    }
  })
  const roomyRisk = await riskGeometry()
  assert.equal(roomyRisk.rowWidths.length, 4)
  assert.ok(roomyRisk.rowWidths.every(width => Math.abs(width - roomyRisk.gridWidth) < 0.6), 'all four rows align to the panel width')
  assert.ok(Math.max(...roomyRisk.rowHeights) - Math.min(...roomyRisk.rowHeights) < 0.6, 'four rows share one visual ratio')
  assert.ok(Math.abs(roomyRisk.sequenceWidth - roomyRisk.faceWidth * 9) < 0.6, 'nine tile columns fill the chart lane')
  assert.ok(roomyRisk.barsHeight >= roomyRisk.faceHeight, 'bars retain at least one tile height')
  assert.ok(roomyRisk.barsHeight > roomyRisk.faceHeight * 1.15, 'bars expand into height not used by capped tiles')
  assert.ok(roomyRisk.scaleHeight > 0 && roomyRisk.scaleRight <= roomyRisk.gridRight + 0.6, 'the scale stays alongside the bars')
  assert.ok(roomyRisk.rowBorders.every(width => width === '0px'), 'risk rows have no divider rules')

  await page.setViewportSize({ width: 1100, height: 1000 })
  await page.waitForTimeout(100)
  const narrowRisk = await riskGeometry()
  assert.ok(narrowRisk.faceWidth < roomyRisk.faceWidth, 'tile width follows the allotted panel width')
  assert.ok(Math.abs((narrowRisk.faceHeight / narrowRisk.faceWidth) - (3.18 / 2.45)) < 0.03, 'tile aspect ratio is retained')

  await page.setViewportSize({ width: 1100, height: 420 })
  await page.waitForTimeout(100)
  const shortRisk = await riskGeometry()
  assert.ok(shortRisk.barsHeight < narrowRisk.barsHeight, 'bars absorb reductions in allotted panel height')
  assert.ok(shortRisk.faceWidth < narrowRisk.faceWidth, `wide but short panels shrink tiles to preserve chart space: ${JSON.stringify({ narrowRisk, shortRisk })}`)

  await page.setViewportSize({ width: 1100, height: 260 })
  await page.waitForTimeout(100)
  const overflowRisk = await riskGeometry()
  assert.ok(overflowRisk.gridMinHeight > overflowRisk.bodyClientHeight, 'the chart keeps its readable minimum height')
  assert.ok(overflowRisk.bodyScrollHeight > overflowRisk.bodyClientHeight, 'only undersized panels need vertical scrolling')
  if (process.env.RMS_RISK_UI_CHECK_SCREENSHOT) {
    await page.setViewportSize({ width: 1400, height: 1000 })
    await page.waitForTimeout(100)
    await page.screenshot({ path: process.env.RMS_RISK_UI_CHECK_SCREENSHOT })
  }

  // Reproduce the real three-column workspace: both count and risk panels are
  // wide but share their columns vertically with another analysis panel.
  await page.setViewportSize({ width: 2560, height: 1392 })
  await page.evaluate(() => {
    const vm = window.analysisCheck.vm
    vm.analysisCountLayout = 'tile-groups'
    vm.settings.display.workspaceLayout = {
      ...vm.workspaceLayout,
      analysisVisible: true,
      consoleVisible: false,
      layout: {
        type: 'split', direction: 'horizontal', weights: [1, 2, 1.3],
        children: [
          { type: 'split', direction: 'vertical', weights: [1, 2], children: [
            { type: 'item', id: 'analysis-opponents' },
            { type: 'item', id: 'analysis-counts' },
          ] },
          { type: 'item', id: 'table' },
          { type: 'split', direction: 'vertical', weights: [1, 1], children: [
            { type: 'item', id: 'analysis-risk' },
            { type: 'item', id: 'analysis-game' },
          ] },
        ],
      },
      analysisPanels: { opponents: true, game: true, risk: true, counts: true },
    }
  })
  const groupedCountGrid = page.locator('.analysis-count-grid')
  await groupedCountGrid.waitFor()
  await page.waitForTimeout(150)
  const splitMetrics = await page.evaluate(() => {
    const visibleBounds = selector => {
      const grid = document.querySelector(selector)
      const body = grid?.closest('.analysis-dock-body')
      const rows = [...(grid?.querySelectorAll('.analysis-tile-chart-row') || [])]
      const tile = grid?.querySelector('.analysis-tile-face')
      return {
        rowCount: rows.length,
        lastRowBottom: rows.at(-1)?.getBoundingClientRect().bottom || 0,
        bodyBottom: body?.getBoundingClientRect().bottom || 0,
        fontSize: grid ? Number.parseFloat(getComputedStyle(grid).fontSize) : 0,
        tileWidth: tile?.getBoundingClientRect().width || 0,
        tileHeight: tile?.getBoundingClientRect().height || 0,
      }
    }
    return { risk: visibleBounds('.analysis-risk-grid'), counts: visibleBounds('.analysis-count-grid') }
  })
  assert.equal(splitMetrics.risk.rowCount, 4)
  assert.equal(splitMetrics.counts.rowCount, 4)
  assert.ok(splitMetrics.risk.lastRowBottom <= splitMetrics.risk.bodyBottom + 0.6, 'all risk rows fit the vertically split panel')
  assert.ok(splitMetrics.counts.lastRowBottom <= splitMetrics.counts.bodyBottom + 0.6, 'all grouped count rows fit the vertically split panel')
  assert.ok(splitMetrics.risk.tileWidth <= splitMetrics.risk.fontSize * 3 + 0.6, 'risk tiles stay within the 3em interface limit')
  assert.ok(splitMetrics.counts.tileWidth <= splitMetrics.counts.fontSize * 3 + 0.6, 'grouped count tiles stay within the 3em interface limit')
  assert.ok(splitMetrics.counts.tileWidth < 60, 'grouped count tiles are height-limited in a wide, short panel')
  if (process.env.RMS_SPLIT_UI_CHECK_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_SPLIT_UI_CHECK_SCREENSHOT })
  }

  // Every rendered tile face uses the table tile's material treatment. Contexts
  // may choose another size, but padding, corner radius and inset scale from the
  // same proportions instead of drifting into panel-specific approximations.
  await page.mouse.move(0, 0)
  await page.evaluate(() => { window.analysisCheck.vm.analysisCountLayout = 'source-rows' })
  await target().waitFor()
  await target().hover()
  await tooltip.waitFor({ state: 'visible' })
  const tileArtwork = await page.evaluate(() => {
    const read = selector => {
      const element = document.querySelector(selector)
      if (!(element instanceof HTMLElement)) return null
      const style = getComputedStyle(element)
      return {
        selector,
        width: element.getBoundingClientRect().width,
        padding: Number.parseFloat(style.paddingLeft),
        radius: Number.parseFloat(style.borderTopLeftRadius),
        background: style.backgroundColor,
        filter: style.filter,
        shadow: style.boxShadow,
      }
    }
    return [
      read('.table-stage .tileImg'),
      read('.analysis-risk-grid .analysis-tile-face'),
      read('.analysis-count-source-tile > img'),
      read('.count-prediction-tooltip .count-tooltip-tile'),
    ]
  })
  const presentTileArtwork = tileArtwork.filter(Boolean)
  assert.equal(presentTileArtwork.length, 4, 'table, risk, count and tooltip tiles are all rendered')
  const tableArtwork = presentTileArtwork[0]
  for (const artwork of presentTileArtwork) {
    const expectedPadding = artwork.width * 2 / 34
    const expectedRadius = (artwork.width - 4) * 4 / 30
    assert.ok(Math.abs(artwork.padding - expectedPadding) < 0.15, `${artwork.selector} keeps the table tile padding ratio`)
    assert.ok(Math.abs(artwork.radius - expectedRadius) < 0.15, `${artwork.selector} keeps the table tile corner ratio`)
    assert.equal(artwork.background, tableArtwork.background, `${artwork.selector} keeps the table tile background`)
    assert.equal(artwork.filter, tableArtwork.filter, `${artwork.selector} keeps the table tile filter`)
    assert.match(artwork.shadow, /inset/, `${artwork.selector} keeps the table tile inset shadow`)
  }
  if (process.env.RMS_TILE_UI_CHECK_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_TILE_UI_CHECK_SCREENSHOT })
  }

  const setNarrowConsoleWidth = async (consoleWidth) => {
    await page.setViewportSize({ width: 800, height: 900 })
    await page.evaluate((width) => {
      const vm = window.analysisCheck.vm
      vm.settings.display.workspaceLayout = {
        ...vm.workspaceLayout,
        analysisVisible: false,
        consoleVisible: true,
        layout: {
          type: 'split', direction: 'horizontal', weights: [width, 800 - width],
          children: [
            { type: 'item', id: 'console' },
            { type: 'item', id: 'table' },
          ],
        },
        analysisPanels: { opponents: false, game: false, risk: false, counts: false },
      }
    }, consoleWidth)
    await page.waitForTimeout(100)
  }
  const consoleGeometry = () => page.evaluate(() => {
    const dock = document.querySelector('.console-dock')
    const body = document.querySelector('.console-dock-body')
    const buttons = [...document.querySelectorAll('.console-dock-body button')]
    const seatButtons = [...document.querySelectorAll('.seat-buttons-compact button')]
    const treeButtons = [...document.querySelectorAll('.tree-actions button')]
    const bounds = body?.getBoundingClientRect()
    const rowCount = elements => new Set(elements.map(element => Math.round(element.getBoundingClientRect().top))).size
    return {
      dockWidth: dock?.getBoundingClientRect().width || 0,
      bodyClientWidth: body?.clientWidth || 0,
      bodyScrollWidth: body?.scrollWidth || 0,
      overflowingButtons: buttons.filter((button) => {
        const rect = button.getBoundingClientRect()
        return bounds && (rect.left < bounds.left - 0.6 || rect.right > bounds.right + 0.6)
      }).map(button => button.textContent?.trim()),
      wrappedSeatButtons: seatButtons.filter(button => getComputedStyle(button).whiteSpace !== 'nowrap').map(button => button.textContent?.trim()),
      clippedButtons: buttons.filter(button => button.scrollWidth > button.clientWidth + 0.6).map(button => button.textContent?.trim()),
      seatRows: rowCount(seatButtons),
      treeRows: rowCount(treeButtons),
      seatColumns: Number(document.querySelector('.seat-buttons-compact')?.dataset.adaptiveColumns || 0),
      treeColumns: Number(document.querySelector('.tree-actions')?.dataset.adaptiveColumns || 0),
      autoColumns: getComputedStyle(document.querySelector('.auto-analysis-row')).gridTemplateColumns.split(' ').length,
    }
  })

  await setNarrowConsoleWidth(300)
  const compactConsole = await consoleGeometry()
  assert.ok(compactConsole.bodyScrollWidth <= compactConsole.bodyClientWidth + 1, 'compact console has no horizontal overflow')
  assert.deepEqual(compactConsole.overflowingButtons, [], 'compact console buttons stay inside the panel')
  assert.deepEqual(compactConsole.clippedButtons, [], 'compact console does not clip button text')
  assert.equal(compactConsole.seatRows, 1, 'seat buttons keep one row while enough width remains')
  assert.equal(compactConsole.treeRows, 1, 'tree actions keep one row while their text fits')

  await setNarrowConsoleWidth(230)
  const narrowConsole = await consoleGeometry()
  assert.ok(narrowConsole.dockWidth < 235 && narrowConsole.dockWidth > 220, 'console receives the intended narrow width')
  assert.ok(narrowConsole.bodyScrollWidth <= narrowConsole.bodyClientWidth + 1, 'narrow console has no horizontal overflow')
  assert.deepEqual(narrowConsole.overflowingButtons, [], 'narrow console buttons stay inside the panel')
  assert.deepEqual(narrowConsole.wrappedSeatButtons, [], 'seat labels remain on one line')
  assert.deepEqual(narrowConsole.clippedButtons, [], 'narrow console switches layout before clipping button text')
  if (process.env.RMS_CONSOLE_UI_CHECK_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_CONSOLE_UI_CHECK_SCREENSHOT })
  }

  await setNarrowConsoleWidth(180)
  const extremeConsole = await consoleGeometry()
  assert.ok(extremeConsole.bodyScrollWidth <= extremeConsole.bodyClientWidth + 1, 'extreme console has no horizontal overflow')
  assert.deepEqual(extremeConsole.overflowingButtons, [], 'extreme console buttons stay inside the panel')
  assert.deepEqual(extremeConsole.wrappedSeatButtons, [], 'seat labels still remain on one line at the extreme width')
  assert.deepEqual(extremeConsole.clippedButtons, [], 'extreme console switches layout before clipping button text')
  assert.equal(extremeConsole.autoColumns, 1, 'automatic analysis stacks at the extreme width')
  assert.equal(extremeConsole.treeRows, 3, 'tree actions use one full-width row each at the extreme width')
  if (process.env.RMS_CONSOLE_EXTREME_UI_CHECK_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_CONSOLE_EXTREME_UI_CHECK_SCREENSHOT })
  }

  for (const language of ['zh-CN', 'ja-JP', 'en-US']) {
    await page.evaluate((value) => {
      window.analysisCheck.vm.settings.display.language = value
    }, language)
    let previousSeatColumns = 4
    let previousTreeColumns = 3
    for (let width = 360; width >= 180; width -= 5) {
      await setNarrowConsoleWidth(width)
      const geometry = await consoleGeometry()
      assert.ok(geometry.bodyScrollWidth <= geometry.bodyClientWidth + 1, `${language} console does not overflow at ${width}px`)
      assert.deepEqual(geometry.overflowingButtons, [], `${language} buttons stay inside at ${width}px`)
      assert.deepEqual(geometry.clippedButtons, [], `${language} buttons reflow before text clips at ${width}px`)
      assert.ok(geometry.seatColumns <= previousSeatColumns, `${language} seat columns decrease monotonically`)
      assert.ok(geometry.treeColumns <= previousTreeColumns, `${language} tree columns decrease monotonically`)
      previousSeatColumns = geometry.seatColumns
      previousTreeColumns = geometry.treeColumns
    }
  }
  assert.deepEqual(errors, [])
  console.log('Analysis UI: event updates, persistent hover, navigation, reopening, stale replies, cache clearing, hand-toggle hints, responsive geometry, narrow console and shared tile artwork passed.')
} finally {
  await browser?.close()
  await server.close()
}
