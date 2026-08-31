import assert from 'node:assert/strict'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

// Real renderer, isolated bridge: no user records, engine processes or settings.
const root = path.resolve(import.meta.dirname, '..')
const server = await createServer({ root, server: { host: '127.0.0.1', port: 0, strictPort: false } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  page.setDefaultTimeout(10000)
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForFunction(() => document.querySelector('#app').__vue_app__?._instance?.setupState.bootstrapError)
  await page.evaluate(() => {
    const vm = document.querySelector('#app').__vue_app__._instance.setupState
    window.analysisCheck = {
      vm, reads: 0, epoch: 0,
      result(expectedValue = 1) {
        return {
          status: 'ready',
          context: { gameId: vm.gameView.gameId, nodeId: vm.gameView.currentNodeId, seat: vm.status.controlledSeat, inputMode: 'public', cacheKey: 'test-engine', cacheEpoch: this.epoch },
          outputs: {
            'wall-tile-count': { tiles: { '1m': { expectedValue, distribution: [{ value: 0, probability: 0.25 }, { value: 1, probability: 0.75 }] } } },
          },
        }
      },
      publish(result = this.result()) {
        vm.handlePythonEvent({ type: 'opponent_analysis_ready', opponentAnalysis: result, gameId: result.context.gameId, nodeId: result.context.nodeId, seat: result.context.seat })
      },
    }
    const check = window.analysisCheck
    window.trainerAPI = {
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
      ...vm.workspaceLayout, analysisVisible: true, consoleVisible: false,
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
  })
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
  assert.deepEqual(errors, [])
  console.log('Analysis UI: event updates, persistent hover, navigation, reopening, stale replies, cache clearing and hand-toggle mouse/keyboard hints passed.')
} finally {
  await browser?.close()
  await server.close()
}
