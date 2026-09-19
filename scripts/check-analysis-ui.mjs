import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { createServer } from 'vite'
import { _electron as electron, chromium } from 'playwright'
import { checkWorkspaceDock } from './check-workspace-dock.mjs'

// Real renderer, isolated bridge: no user records, engine processes or settings.
const root = path.resolve(import.meta.dirname, '..')
const realisticPerformance = Boolean(process.env.RMS_UI_REALISTIC_PERFORMANCE)
const performanceOnly = Boolean(process.env.RMS_UI_PERFORMANCE_ONLY)

function loadRealisticAnalysisFixtures() {
  if (!realisticPerformance) return []
  const encoded = fs.readFileSync(path.join(root, 'examples', 'example-record.mjstudio'))
  const record = JSON.parse(zlib.gunzipSync(encoded).toString('utf8'))
  const unique = new Map()
  for (const node of Object.values(record.game?.nodes || {})) {
    for (const value of Object.values(node?.opponentAnalysisCache || {})) {
      if (!value?.outputs || Object.keys(value.outputs).length < 8) continue
      const serialized = JSON.stringify(value)
      if (!unique.has(serialized)) unique.set(serialized, value)
    }
  }
  return [...unique.entries()]
    .sort((left, right) => right[0].length - left[0].length)
    .slice(0, 2)
    .map(([, value]) => value)
}

const realisticAnalysisFixtures = loadRealisticAnalysisFixtures()
const server = await createServer({ root, mode: 'ui-test', server: { host: '127.0.0.1', port: 0, strictPort: false } })
let browser
let electronApp
try {
  await server.listen()
  let page
  if (process.env.RMS_UI_ELECTRON) {
    electronApp = await electron.launch({
      args: [path.join(root, 'scripts', 'electron-ui-test-main.cjs')],
      env: {
        ...process.env,
        RMS_UI_TEST_URL: server.resolvedUrls.local[0],
      },
    })
    page = await electronApp.firstWindow()
    await page.setViewportSize({ width: 1400, height: 1000 })
    if (process.env.RMS_UI_PERFORMANCE_DIAGNOSTIC) {
      const gpu = await electronApp.evaluate(async ({ app }) => ({
        argv: process.argv,
        disableGpu: app.commandLine.hasSwitch('disable-gpu'),
        useAngle: app.commandLine.getSwitchValue('use-angle'),
        featureStatus: app.getGPUFeatureStatus(),
        basicInfo: await app.getGPUInfo('basic'),
      }))
      console.log(`Electron GPU: ${JSON.stringify(gpu)}`)
    }
  } else {
    browser = await chromium.launch({
      headless: true,
      args: process.env.RMS_UI_UNTHROTTLED
        ? ['--disable-frame-rate-limit', '--disable-gpu-vsync']
        : [],
    })
    page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  }
  page.setDefaultTimeout(10000)
  if (realisticAnalysisFixtures.length) {
    await page.addInitScript((fixtures) => {
      window.rmsRealisticAnalysisFixtures = fixtures
    }, realisticAnalysisFixtures)
  }
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
  await page.addInitScript(() => {
    window.setupRmsAnalysisTest = vm => {
      window.analysisCheck = {
        vm, reads: 0, epoch: 0, wallReads: 0, runtimeMetricReads: 0, settingsSaves: [],
        result(expectedValue = 1) {
          return {
            status: 'ready',
            context: { gameId: vm.gameView.gameId, nodeId: vm.gameView.currentNodeId, seat: vm.status.controlledSeat, inputMode: 'public', cacheKey: 'test-engine', cacheEpoch: this.epoch },
            outputs: {
              'wall-tile-count': { tiles: { '1m': { expectedValue, distribution: [
                { value: 0, probability: expectedValue <= 1 ? 0.8 : 0.1 },
                { value: 1, probability: expectedValue <= 1 ? 0.2 : 0.9 },
              ] } } },
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
                    distribution: [1000, 2000, 3900, 5800, 7700, 11600, 11700, 8000, 12000, 16000, 24000, 32000, 48000, 64000, 96000].map((value, valueIndex) => ({
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
                      .map((tile, tileIndex) => [
                        tile,
                        Math.min(0.95, (((tileIndex + sourceIndex) % 5) + 1) * 0.025 * expectedValue),
                      ]),
                  ),
                })),
              },
            },
          }
        },
        resultForNode(nodeId, expectedValue = 1) {
          const result = this.result(expectedValue)
          result.context.nodeId = nodeId
          const riskPlayers = result.outputs?.['opponent-deal-in-probability']?.players || []
          if (riskPlayers[0]?.tiles) {
            // Change the shape as well as the magnitude. A uniform multiplier is
            // intentionally invisible after the chart's adaptive normalization.
            riskPlayers[0].tiles['1m'] = Math.min(0.95, 0.015 + (expectedValue * 0.07))
          }
          const doraDistribution = result.outputs?.['opponent-dora-count']?.players?.[0]?.prediction?.distribution
          if (doraDistribution?.length >= 2) {
            doraDistribution[0].probability = expectedValue <= 1 ? 0.68 : 0.12
            doraDistribution[1].probability = expectedValue <= 1 ? 0.12 : 0.68
          }
          const distributions = [
            [0.52, 0.24, 0.12, 0.06, 0.03, 0.02, 0.01, 0],
            [0.18, 0.42, 0.2, 0.1, 0.05, 0.03, 0.01, 0.01],
            [0.08, 0.2, 0.4, 0.16, 0.08, 0.04, 0.02, 0.02],
          ]
          const shift = Math.max(0, Math.min(2, Math.round(expectedValue) - 1))
          result.predictions = {
            opponents: {
              kamicha: distributions[(0 + shift) % distributions.length],
              toimen: distributions[(1 + shift) % distributions.length],
              shimocha: distributions[(2 + shift) % distributions.length],
            },
            ron_wait: Object.fromEntries(['kamicha', 'toimen', 'shimocha'].map((key, sourceIndex) => [
              key,
              Array.from({ length: 34 }, (_, tileIndex) => (
                Math.min(0.95, ((((tileIndex + sourceIndex + shift) % 5) + 1) * 0.025 * expectedValue))
              )),
            ])),
          }
          return result
        },
        realisticResultForNode(index, nodeId) {
          const fixture = window.rmsRealisticAnalysisFixtures?.[index]
          if (!fixture) return null
          const result = structuredClone(fixture)
          result.context = {
            gameId: vm.gameView.gameId,
            nodeId,
            seat: vm.status.controlledSeat,
            inputMode: 'public',
            cacheKey: 'realistic-example',
            cacheEpoch: this.epoch,
          }
          const riskPlayers = result.outputs?.['opponent-deal-in-probability']?.players || []
          if (riskPlayers[0]?.tiles) {
            riskPlayers[0].tiles['1m'] = index === 0 ? 0.0125 : 0.2875
          }
          const doraDistribution = result.outputs?.['opponent-dora-count']?.players?.[0]?.prediction?.distribution
          if (doraDistribution?.length >= 2) {
            doraDistribution[0].probability = index === 0 ? 0.68 : 0.12
            doraDistribution[1].probability = index === 0 ? 0.12 : 0.68
          }
          const wallCountDistribution = result.outputs?.['wall-tile-count']?.tiles?.['1m']?.distribution
          if (wallCountDistribution?.length >= 2) {
            wallCountDistribution[0].probability = index === 0 ? 0.8 : 0.1
            wallCountDistribution[1].probability = index === 0 ? 0.2 : 0.9
          }
          result.predictions ||= {}
          result.predictions.ron_wait = Object.fromEntries(['kamicha', 'toimen', 'shimocha'].map((key, sourceIndex) => [
            key,
            Array.from({ length: 34 }, (_, tileIndex) => (
              Math.min(0.95, ((((tileIndex + sourceIndex + index) % 5) + 1) * 0.025 * (index + 1)))
            )),
          ]))
          return result
        },
        publish(result = this.result()) {
          vm.handlePythonEvent({ type: 'opponent_analysis_ready', opponentAnalysis: result, gameId: result.context.gameId, nodeId: result.context.nodeId, seat: result.context.seat })
        },
      }
      const check = window.analysisCheck
      if (vm.showPerceptualColorDebugger !== false) throw new Error('F8 debugger must start hidden')
      // Keep copy assertions independent of the host operating-system locale.
      // Dedicated responsive checks below still exercise every supported language.
      vm.settings.display.language = 'zh-CN'
      window.studioAPI = {
        getSettings: async () => JSON.parse(JSON.stringify(vm.settings)),
        getStatus: async () => JSON.parse(JSON.stringify(vm.status)),
        getRuntimeMetrics: async () => {
          check.runtimeMetricReads++
          return {
            electronBytes: 512 * 1024 * 1024,
            backendBytes: 256 * 1024 * 1024,
            engineBytes: 0,
            engineProcessCount: 0,
            systemTotalBytes: 16 * 1024 * 1024 * 1024,
            systemAvailableBytes: 8 * 1024 * 1024 * 1024,
          }
        },
        restoreStartupRecovery: async () => null,
        getRecordDirty: async () => false,
        onRecordDirtyChanged: callback => { check.notifyDirty = callback; return () => {} },
        getAnalysis: async () => { check.reads++; return check.result() },
        getWallView: async () => {
          check.wallReads++
          return {
            tiles: [{ index: 0, tile: '1m', status: 'available' }],
            complete: true,
            canReconstruct: false,
            seed: 123,
            origin: 'generated',
            sourceUrl: null,
          }
        },
        setAnalysisVisibility: async () => ({ state: JSON.parse(JSON.stringify(vm.status)) }),
        saveSettings: async settings => { check.settingsSaves.push(JSON.parse(JSON.stringify(settings))); return settings },
        describeEngine: async request => ({
          protocol: { name: 'riichi-engine-protocol', major: 2, minor: 2 },
          engine: { id: request.engineId || 'ui-test-engine', name: 'UI Test Engine', version: request.engineVersion || '1.0.0' },
          outputContracts: [{ id: 'opponent-shanten', methods: ['analysis.get'] }],
          weightSlots: [],
          devices: [{ type: 'cpu', title: 'CPU' }],
          optionsSchema: {
            type: 'object',
            properties: {
              sampleCount: { type: 'integer', minimum: 0, maximum: 4, default: 2 },
            },
          },
        }),
        toggleVisibleHands: async () => ({ ...JSON.parse(JSON.stringify(vm.status)), visibleHands: !vm.status.visibleHands }),
        getGameView: async () => ({ state: JSON.parse(JSON.stringify(vm.status)), view: JSON.parse(JSON.stringify(vm.gameView)) }),
        clearAnalysisCaches: async () => {
          check.epoch++
          return { state: JSON.parse(JSON.stringify(vm.status)), cleared: { decisionEntries: 0, opponentEntries: 1, comparisons: 0, treeRevision: 1, decisionCacheEpoch: check.epoch, opponentCacheEpoch: check.epoch } }
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
  // A fresh CI runner has to start Vite and decode the complete tile artwork set
  // without the warm caches available during local iteration. Keep ordinary UI
  // assertions on the short default timeout, but give this one-time bootstrap its
  // own cold-start budget.
  await page.waitForFunction(() => window.analysisCheck?.vm.tileArtworkReady, null, { timeout: 30000 })
  if (process.env.RMS_UI_SCREENSHOT) {
    await page.screenshot({ path: path.resolve(process.env.RMS_UI_SCREENSHOT), fullPage: true })
  }
  assert.equal(await page.evaluate(() => window.analysisCheck.vm.bootstrapError), '', 'fixture boots through the normal desktop bridge path')
  if (!performanceOnly) {
  await page.evaluate(() => { window.analysisCheck.vm.showMjaiDebug = true })
  assert.deepEqual(
    await page.locator('.mjai-debug-panel').evaluate(panel => ({
      maxHeight: getComputedStyle(panel).maxHeight,
      headerPosition: getComputedStyle(panel.querySelector('.settings-modal-header')).position,
      backgroundImage: getComputedStyle(panel).backgroundImage,
      headerBackgroundImage: getComputedStyle(panel.querySelector('.settings-modal-header')).backgroundImage,
    })),
    { maxHeight: '900px', headerPosition: 'static', backgroundImage: 'none', headerBackgroundImage: 'none' },
    'MJAI debug dialog keeps its component-owned geometry and uses solid shared surfaces',
  )
  await page.locator('.mjai-debug-panel .settings-modal-actions button').last().click()
  assert.equal(
    await page.locator('.mjai-debug-panel').count(),
    0,
    'MJAI debug dialog closes through its component event',
  )
  await page.evaluate(() => window.analysisCheck.vm.openWallView())
  assert.equal(
    await page.locator('.analysis-float-panel').evaluate(panel => getComputedStyle(panel).backgroundImage),
    'none',
    'floating tools use the shared solid panel surface',
  )
  assert.deepEqual(
    await page.evaluate(() => ({
      open: window.analysisCheck.vm.showWallView,
      tiles: window.analysisCheck.vm.wallTiles,
      reads: window.analysisCheck.wallReads,
    })),
    { open: true, tiles: [{ index: 0, tile: '1m', status: 'available' }], reads: 1 },
    'wall view owns and publishes its loaded state',
  )
  await page.evaluate(() => window.analysisCheck.vm.closeWallView(true))
  assert.deepEqual(
    await page.evaluate(() => ({ open: window.analysisCheck.vm.showWallView, tiles: window.analysisCheck.vm.wallTiles })),
    { open: false, tiles: [] },
    'closing the record clears wall view state through its owner',
  )
  await page.evaluate(() => {
    const vm = window.analysisCheck.vm
    vm.settings.engines.profiles = Array.from({ length: 14 }, (_, index) => ({
      id: index === 0 ? 'profile.ui-test' : `profile.ui-test-${index}`,
      name: index === 0 ? 'UI Test Engine' : `Additional UI Test Engine ${index}`,
      engineId: 'ui-test-engine', engineVersion: '1.0.0',
      enginePath: 'C:\\ui-test\\engine.exe', engineCommand: ['C:\\ui-test\\engine.exe'], engineCwd: '',
      builtIn: false, available: true, autoName: false, weights: [], device: 'cpu', options: { sampleCount: 2 },
    }))
    vm.settings.engines.outputAssignments['opponent-shanten'] = 'profile.ui-test'
    vm.openEngineWindow()
  })
  await page.locator('.engine-window').waitFor()
  assert.equal(await page.evaluate(() => window.analysisCheck.vm.showEngineWindow), true)
  const engineWindowMetrics = await page.evaluate(() => {
    const windowElement = document.querySelector('.engine-window')
    const list = document.querySelector('.engine-profile-list')
    const detail = document.querySelector('.engine-profile-detail')
    if (!(windowElement instanceof HTMLElement) || !(list instanceof HTMLElement) || !(detail instanceof HTMLElement)) return null
    const windowRect = windowElement.getBoundingClientRect()
    list.scrollTop = list.scrollHeight
    return {
      windowWidth: windowRect.width,
      windowHeight: windowRect.height,
      windowBottom: windowRect.bottom,
      viewportHeight: window.innerHeight,
      listClientHeight: list.clientHeight,
      listScrollHeight: list.scrollHeight,
      listScrollTop: list.scrollTop,
      listOverflowY: getComputedStyle(list).overflowY,
      detailOverflowY: getComputedStyle(detail).overflowY,
    }
  })
  assert.ok(engineWindowMetrics.windowHeight >= 600, 'engine manager uses the taller working shape')
  assert.ok(engineWindowMetrics.windowHeight / engineWindowMetrics.windowWidth >= 0.8, 'engine manager is not disproportionately short')
  assert.ok(engineWindowMetrics.windowBottom <= engineWindowMetrics.viewportHeight, 'engine manager stays inside the viewport')
  assert.ok(engineWindowMetrics.listScrollHeight > engineWindowMetrics.listClientHeight, 'long engine lists overflow their dedicated list area')
  assert.ok(engineWindowMetrics.listScrollTop > 0, 'the engine profile list can be scrolled')
  assert.equal(engineWindowMetrics.listOverflowY, 'auto', 'the engine profile list owns its vertical scrollbar')
  assert.equal(engineWindowMetrics.detailOverflowY, 'auto', 'engine details retain their independent vertical scrollbar')
  if (process.env.RMS_ENGINE_UI_CHECK_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_ENGINE_UI_CHECK_SCREENSHOT })
  }
  await page.locator('.engine-profile-detail input[type="text"]').first().fill('Renamed UI Test Engine')
  const numericOption = page.locator('.engine-profile-detail input[inputmode="numeric"]')
  await numericOption.fill('9')
  await numericOption.press('Tab')
  await page.waitForFunction(() => window.analysisCheck.vm.engineSaveMessage !== '')
  assert.equal(await numericOption.inputValue(), '2', 'invalid engine option restores the persisted value')
  await page.evaluate(() => window.analysisCheck.vm.closeEngineWindow())
  await page.waitForFunction(() => window.analysisCheck.settingsSaves.some(save => (
    save.engines?.profiles?.[0]?.name === 'Renamed UI Test Engine'
  )))
  assert.equal(await page.locator('.engine-window').count(), 0, 'engine profile owner closes and flushes its editor')
  assert.equal(
    await page.locator('.auto-analysis-progress small').evaluate(element => getComputedStyle(element).opacity),
    '1',
    'auto-analysis progress details stay visible without hover',
  )
  await page.evaluate(() => {
    const vm = window.analysisCheck.vm
    window.originalSpecialActionFixture = {
      legalActions: JSON.parse(JSON.stringify(vm.gameView.legalActions)),
      analysis: JSON.parse(JSON.stringify(vm.gameView.analysis)),
    }
    vm.gameView.legalActions = [
      { id: 'pon-ui-test', candidateId: 'pon-ui-test', type: 'pon', variant: 'pon', actor: 0, target: 1, pai: '5m', consumed: ['5m', '5m'] },
      { id: 'skip-ui-test', candidateId: 'skip-ui-test', type: 'none', variant: 'none', actor: 0 },
    ]
    vm.gameView.analysis = {
      model: 'ui-test-decision',
      seat: 0,
      bestAction: { type: 'none', variant: 'none' },
      reactionEntries: [
        { candidateId: 'pon-ui-test', type: 'pon', variant: 'pon', label: 'pon', value: 0.08, bar: 0.08 },
        { candidateId: 'skip-ui-test', type: 'none', variant: 'none', label: 'skip', value: 0.92, bar: 0.92, isBest: true },
      ],
    }
  })
  const specialActionOptions = page.locator('.special-action-option')
  await specialActionOptions.nth(1).waitFor()
  await specialActionOptions.nth(1).evaluate(element => element.classList.add('special-next-main'))
  await page.waitForTimeout(150)
  const specialActionGeometry = await page.locator('.special-action-board').evaluate(board => {
    const options = [...board.querySelectorAll('.special-action-option')]
    const trackBottoms = options.map(option => option.querySelector('.special-action-bar-track').getBoundingClientRect().bottom)
    const fillStyles = options.map(option => getComputedStyle(option.querySelector('.special-action-bar-fill')).clipPath)
    const label = options[1].querySelector('.special-action-label')
    const labelRect = label.getBoundingClientRect()
    const range = document.createRange()
    range.selectNodeContents(label)
    const textRect = range.getBoundingClientRect()
    const fontSize = Number.parseFloat(getComputedStyle(label).fontSize)
    return {
      trackBottoms,
      fillStyles,
      fontSize,
      gaps: {
        left: textRect.left - labelRect.left,
        right: labelRect.right - textRect.right,
        top: textRect.top - labelRect.top,
        bottom: labelRect.bottom - textRect.bottom,
      },
    }
  })
  assert.ok(
    Math.max(...specialActionGeometry.trackBottoms) - Math.min(...specialActionGeometry.trackBottoms) < 0.01,
    'special-action recommendation tracks share one exact bottom edge',
  )
  assert.ok(
    specialActionGeometry.fillStyles.every(value => value.startsWith('inset(')),
    'special-action fills reveal their fixed track with clipping instead of separately rasterized scaling',
  )
  assert.ok(
    specialActionGeometry.gaps.left >= specialActionGeometry.fontSize * 0.25
      && specialActionGeometry.gaps.right >= specialActionGeometry.fontSize * 0.25,
    'next-action outlines retain readable horizontal space around their labels',
  )
  assert.ok(
    Math.abs(specialActionGeometry.gaps.top - specialActionGeometry.gaps.bottom) <= specialActionGeometry.fontSize * 0.12,
    `next-action labels remain visually centered inside their outline box: ${JSON.stringify(specialActionGeometry.gaps)}`,
  )
  if (process.env.RMS_SPECIAL_ACTION_SCREENSHOT) {
    await page.locator('.special-action-stage').screenshot({ path: process.env.RMS_SPECIAL_ACTION_SCREENSHOT })
  }
  await page.evaluate(() => {
    const vm = window.analysisCheck.vm
    vm.gameView.legalActions = window.originalSpecialActionFixture.legalActions
    vm.gameView.analysis = window.originalSpecialActionFixture.analysis
    vm.gameView.tree = {
      rootNodeId: 'node-1',
      currentNodeId: 'node-1',
      mainLeafNodeId: 'node-2',
      currentRoundRootId: 'node-1',
      revision: 1,
      nodes: [
        { id: 'node-1', parentId: null, children: ['node-2'], mainChildId: 'node-2', depth: 0, roundDepth: 0, type: 'root', action: null, isCurrent: true },
        { id: 'node-2', parentId: 'node-1', children: [], mainChildId: null, depth: 1, roundDepth: 1, type: 'action', action: { type: 'discard', actor: 0, pai: '1m' }, isCurrent: false },
      ],
      rounds: [],
    }
    delete window.originalSpecialActionFixture
  })
  const treeHitRegion = page.locator('.tree-hit-region').last()
  await treeHitRegion.hover()
  assert.equal(await page.locator('.tree-hover-indicator').count(), 1, 'the hovered branch node receives one crisp indicator')
  assert.equal(await page.locator('.tree-axis-label.is-hovered').count(), 1, 'branch labels share the active node hover feedback')
  assert.notEqual(
    await page.locator('.tree-axis-label.is-hovered').evaluate(element => getComputedStyle(element).boxShadow),
    'none',
    'the hovered branch row uses a clear outline instead of a faint brightness filter',
  )
  if (process.env.RMS_BRANCH_HOVER_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_BRANCH_HOVER_SCREENSHOT })
  }
  await page.mouse.move(0, 0)
  await page.evaluate(() => {
    const vm = window.analysisCheck.vm
    vm.gameView.tree.currentRoundRootId = 'round-1'
    vm.gameView.tree.rounds = [
      {
        id: 'round-1', parentRoundId: null, childRoundIds: ['round-2'], mainNextRoundId: 'round-2',
        depth: 0, roundIndex: 0, bakaze: 'E', kyoku: 1, honba: 0, kyotaku: 0,
        scores: [25000, 25000, 25000, 25000], tailScores: [25000, 25000, 25000, 25000],
        phase: 'draw', tailPhase: 'draw', resultInfo: null, matchEndInfo: null, isCurrent: true,
      },
      {
        id: 'round-2', parentRoundId: 'round-1', childRoundIds: [], mainNextRoundId: null,
        depth: 1, roundIndex: 1, bakaze: 'E', kyoku: 2, honba: 0, kyotaku: 0,
        scores: [27000, 24000, 25000, 24000], tailScores: [27000, 24000, 25000, 24000],
        phase: 'draw', tailPhase: 'draw', resultInfo: null, matchEndInfo: null, isCurrent: false,
      },
    ]
  })
  await page.locator('.info-round').click()
  const roundMapHitRegion = page.locator('.round-map-hit-region').last()
  await roundMapHitRegion.hover()
  assert.equal(await page.locator('.round-map-hover-indicator').count(), 1, 'the hovered round-map node receives one crisp indicator')
  const roundMapHoverGeometry = await page.locator('.round-map-svg').evaluate(svg => {
    const indicator = svg.querySelector('.round-map-hover-indicator')
    const dots = [...svg.querySelectorAll('.round-map-dot')]
    const hoveredDot = dots.find(dot => (
      dot.getAttribute('cx') === indicator?.getAttribute('cx')
      && dot.getAttribute('cy') === indicator?.getAttribute('cy')
    ))
    if (!indicator || !hoveredDot) throw new Error('round-map hover indicator is not aligned to a node')
    const style = getComputedStyle(indicator)
    return {
      dotRadius: Number(hoveredDot.getAttribute('r')),
      indicatorRadius: Number(indicator.getAttribute('r')),
      fill: style.fill,
      stroke: style.stroke,
    }
  })
  assert.ok(roundMapHoverGeometry.indicatorRadius > roundMapHoverGeometry.dotRadius, 'the round-map hover outline surrounds the node instead of recoloring it')
  assert.notEqual(roundMapHoverGeometry.fill, 'none', 'the round-map hover indicator keeps the branch-tree pale fill')
  assert.notEqual(roundMapHoverGeometry.stroke, 'none', 'the round-map hover indicator keeps the branch-tree crisp outline')
  if (process.env.RMS_ROUND_MAP_HOVER_SCREENSHOT) {
    await page.locator('.round-map-window').screenshot({ path: process.env.RMS_ROUND_MAP_HOVER_SCREENSHOT })
  }
  await page.locator('.round-map-window .floating-panel-close').click()
  await page.evaluate(() => {
    const vm = window.analysisCheck.vm
    vm.gameView.tree.currentRoundRootId = 'node-1'
    vm.gameView.tree.rounds = []
  })
  for (const operation of ['saveGame', 'saveGameAs']) {
    await page.evaluate(async operation => {
      const check = window.analysisCheck
      const vm = check.vm
      const originalView = JSON.parse(JSON.stringify(vm.gameView))
      const originalState = JSON.parse(JSON.stringify(vm.status))
      vm.recordDirty = true
      let finish
      window.studioAPI[operation] = () => new Promise(resolve => { finish = resolve })
      const saving = vm[operation]()
      while (!finish) await new Promise(resolve => setTimeout(resolve, 0))
      window.studioAPI.jumpToNode = async nodeId => ({ state: originalState, view: { ...originalView, currentNodeId: nodeId } })
      await vm.jumpToNode('saved-during-navigation')
      check.notifyDirty(false)
      check.notifyDirty(true)
      finish({ state: originalState, view: originalView, path: 'test-save.mjstudio', recordDirty: false, recoveryRecord: false })
      await saving
      if (vm.gameView.currentNodeId !== 'saved-during-navigation') throw new Error(`${operation} rewound the current node`)
      if (!vm.recordDirty) throw new Error(`${operation} cleared a newer dirty notification`)
      if (vm.recordPath !== 'test-save.mjstudio') throw new Error(`${operation} failed to update its path`)
      await vm.jumpToNode(originalView.currentNodeId)
      window.studioAPI[operation] = async () => {
        check.notifyDirty(false)
        return { state: originalState, view: originalView, path: 'test-save.mjstudio', recordDirty: false, recoveryRecord: false }
      }
      await vm[operation]()
      if (vm.recordDirty) throw new Error(`${operation} did not accept a clean save`)
    }, operation)
  }
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
    const read = window.studioAPI.getAnalysis
    window.studioAPI.getAnalysis = () => new Promise(resolve => { check.resolveRead = resolve })
    check.pendingRead = check.vm.fetchAnalysisOnce()
    window.studioAPI.getAnalysis = read
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
    const read = window.studioAPI.getAnalysis
    window.studioAPI.getAnalysis = () => new Promise(resolve => { check.resolveRead = resolve })
    check.pendingRead = check.vm.fetchAnalysisOnce()
    check.oldResult = check.result()
    window.studioAPI.getAnalysis = read
  })
  await page.evaluate(() => window.analysisCheck.vm.clearLoadedAnalysisCaches())
  await page.evaluate(async () => { const check = window.analysisCheck; check.resolveRead(check.oldResult); await check.pendingRead })
  await page.evaluate(() => {
    const check = window.analysisCheck
    const vm = check.vm
    const revision = vm.gameView.tree?.revision
    check.publish(check.oldResult)
    for (const type of ['analysis_ready', 'auto_analysis_tree_updates']) {
      vm.handlePythonEvent({ type, gameId: vm.gameView.gameId, nodeId: vm.gameView.currentNodeId,
        cacheEpoch: check.epoch - 1, analysis: {}, treeRevision: 9999 })
    }
    if (vm.gameView.analysis !== null) throw new Error('Old decision event revived cleared analysis')
    if (vm.gameView.tree?.revision !== revision) throw new Error('Old tree event changed the cleared tree')
  })
  assert.equal(await page.evaluate(() => window.analysisCheck.vm.gameView.opponentAnalysis), null)
  assert.equal(await page.evaluate(() => window.analysisCheck.vm.opponentAnalysisIsLoading), false, 'cleared idle panels are empty, not loading forever')
  assert.equal(await tooltip.count(), 0)
  const afterClear = await readCount()
  await page.waitForTimeout(2500)
  assert.equal(await readCount(), afterClear, 'cleared data is not silently requested again')
  assert.equal(await page.evaluate(() => window.analysisCheck.vm.gameView.opponentAnalysis), null)

  await page.evaluate(() => {
    const check = window.analysisCheck
    const savedStatus = JSON.parse(JSON.stringify(check.vm.status))
    const savedNodeId = check.vm.gameView.currentNodeId
    check.vm.status.autoAnalysis.status = 'running'
    check.vm.status.modelRuntime.decision = { profileId: 'test', ready: true, unloaded: false,
      profiles: { test: { ready: true, unloaded: false } } }
    check.vm.status.modelRuntime.opponentAnalysis = { profileId: 'test', ready: true, unloaded: false }
    check.vm.status.modelActivity.opponentAnalysis = 'running'
    check.vm.handlePythonEvent({ type: 'service_stopped' })
    if (check.vm.status.autoAnalysis.status !== 'canceled') throw new Error('Backend exit left automatic analysis running')
    if (check.vm.status.modelRuntime.decision.ready || check.vm.status.modelRuntime.opponentAnalysis.ready) throw new Error('Backend exit left engines ready')
    if (check.vm.status.modelRuntime.decision.profiles?.test?.ready) throw new Error('Backend exit left per-profile readiness')
    if (check.vm.status.gameLoaded) throw new Error('Backend exit left the game playable')
    if (check.vm.gameView.currentNodeId !== savedNodeId) throw new Error('Backend exit discarded the visible record')
    if (check.vm.opponentAnalysisIsLoading) throw new Error('Backend exit left analysis loading')
    check.vm.handlePythonEvent({ type: 'service_ready' })
    if (check.vm.status.gameLoaded) throw new Error('Readiness alone made the retained game playable')
    check.vm.handlePythonEvent({ type: 'service_restored', state: savedStatus,
      view: JSON.parse(JSON.stringify(check.vm.gameView)) })
    if (check.vm.status.gameLoaded !== savedStatus.gameLoaded) throw new Error('Restored game status was not applied')
    if (check.vm.gameView.currentNodeId !== savedNodeId) throw new Error('Recovery changed the selected node')
    check.epoch = 0
    const result = check.result(2)
    check.publish(result)
    if (!check.vm.gameView.opponentAnalysis) throw new Error('New backend epoch zero was rejected')
  })

  // The visible retry control must restart the backend, not repeat bootstrap reads.
  for (const hasCheckpoint of [true, false]) {
    await page.evaluate(hasCheckpoint => {
      const check = window.analysisCheck
      check.recoverySavedState = JSON.parse(JSON.stringify(check.vm.status))
      check.recoverySavedView = JSON.parse(JSON.stringify(check.vm.gameView))
      check.restartCalls = 0
      window.studioAPI.restartBackend = () => {
        check.restartCalls++
        return new Promise((resolve, reject) => { check.finishRestart = resolve; check.failRestart = reject })
      }
      check.vm.handlePythonEvent({ type: 'service_stopped', hasCheckpoint })
    }, hasCheckpoint)
    const retry = page.locator('.startup-banner button')
    assert.equal(await retry.textContent().then(text => text.trim()), hasCheckpoint ? '恢复对局' : '重新启动')
    if (!hasCheckpoint && process.env.RMS_RECOVERY_SCREENSHOT) {
      await page.screenshot({ path: process.env.RMS_RECOVERY_SCREENSHOT })
    }
    await retry.click()
    assert.equal(await retry.isDisabled(), true)
    assert.equal(await page.evaluate(() => window.analysisCheck.restartCalls), 1)
    await page.evaluate(() => window.analysisCheck.failRestart(new Error('test restart failure')))
    await page.waitForFunction(() => !document.querySelector('.startup-banner button').disabled)
    assert.match(await page.locator('.startup-banner').textContent(), /test restart failure/)
    await retry.click()
    await page.evaluate(hasCheckpoint => {
      const check = window.analysisCheck
      const state = hasCheckpoint ? check.recoverySavedState : { ...check.recoverySavedState, gameLoaded: false }
      const view = hasCheckpoint ? check.recoverySavedView : { ...check.recoverySavedView,
        gameId: null, matchId: null, currentNodeId: null, table: null, tree: null,
        nodeComment: '', legalActions: [], analysis: null, opponentAnalysis: null, pendingReview: null }
      check.vm.handlePythonEvent({ type: 'service_restored', state, view })
      if (!hasCheckpoint && (check.vm.status.gameLoaded || check.vm.gameView.currentNodeId)) throw new Error('Empty restart retained the old game')
      check.finishRestart({ ok: true })
    }, hasCheckpoint)
    await page.waitForFunction(() => !document.querySelector('.startup-banner'))
    assert.equal(await page.evaluate(() => window.analysisCheck.restartCalls), 2)
    await page.evaluate(() => {
      const check = window.analysisCheck
      check.vm.handlePythonEvent({ type: 'service_restored', state: check.recoverySavedState, view: check.recoverySavedView })
    })
  }

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
    const result = window.analysisCheck.resultForNode(vm.gameView.currentNodeId, 1)
    for (const player of result.outputs['opponent-dora-count'].players) {
      player.prediction.distribution = [
        { value: 0, probability: 0.25 },
        { value: 1, probability: 0.2 },
        { value: 2, probability: 0.15 },
        { value: 3, probability: 0.12 },
        { value: 4, probability: 0.1 },
        { value: 5, probability: 0.08 },
        { value: 6, probability: 0.06 },
        { value: '7+', probability: 0.04 },
      ]
    }
    for (const player of result.outputs['opponent-score'].players) {
      player.prediction.distribution = [
        { value: 1000, probability: 0.22 },
        { value: 2000, probability: 0.19 },
        { value: 3900, probability: 0.17 },
        { value: 7700, probability: 0.16 },
        { value: 8000, probability: 0.14 },
        { value: 12000, probability: 0.11 },
        { value: 128000, probability: 0.01 },
      ]
    }
    window.analysisCheck.publish(result)
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
  const opponentGeometry = async () => page.locator('.analysis-panel-live:not(.analysis-panel-snapshot) > .analysis-opponent-section').evaluate(section => {
    const dora = section.querySelector('.analysis-dora-distribution')
    const score = section.querySelector('.analysis-score-distribution')
    const grid = section.querySelector('.analysis-opponent-prediction-grid')
    const predictions = [...section.querySelectorAll('.analysis-opponent-prediction')]
    const sectionBounds = section.getBoundingClientRect()
    const gridBounds = grid?.getBoundingClientRect()
    return {
      sectionHeight: sectionBounds.height,
      gridHeight: gridBounds?.height || 0,
      unusedBottomHeight: gridBounds ? sectionBounds.bottom - gridBounds.bottom : 0,
      doraHeight: dora?.getBoundingClientRect().height || 0,
      scoreHeight: score?.getBoundingClientRect().height || 0,
      chartsStayInsideRows: [dora, score].every((chart) => {
        if (!chart) return true
        const chartBounds = chart.getBoundingClientRect()
        const row = predictions.find((prediction) => prediction.contains(chart))
        const rowBounds = row?.getBoundingClientRect()
        return Boolean(rowBounds)
          && chartBounds.top >= rowBounds.top - 0.5
          && chartBounds.bottom <= rowBounds.bottom + 0.5
      }),
    }
  })
  await page.locator('.analysis-dora-distribution').first().waitFor()
  await page.waitForFunction(() => {
    const groups = [...document.querySelectorAll('.analysis-score-modes')]
    return groups.length === 3
      && groups[0].children.length > 3
      && groups.every((group) => group.children.length === groups[0].children.length)
  })
  const scoreModeCounts = await page.locator('.analysis-score-modes').evaluateAll(groups => (
    groups.map(group => group.children.length)
  ))
  assert.equal(new Set(scoreModeCounts).size, 1, 'all opponents show the same width-derived number of score nominations')
  assert.ok(scoreModeCounts[0] > 3, 'a roomy panel shows more than the former fixed three score nominations')
  const scoreModePixelGeometry = await page.locator('.analysis-score-modes').evaluateAll((groups) => {
    const ratio = window.devicePixelRatio
    return groups.map((group) => {
      const cells = [...group.children].map(cell => cell.getBoundingClientRect())
      return {
        widths: cells.map(bounds => bounds.width * ratio),
        gaps: cells.slice(1).map((bounds, index) => (bounds.left - cells[index].right) * ratio),
      }
    })
  })
  const physicalScoreModeWidths = scoreModePixelGeometry.flatMap(group => group.widths)
  const physicalScoreModeGaps = scoreModePixelGeometry.flatMap(group => group.gaps)
  assert.ok(physicalScoreModeWidths.every(width => Math.abs(width - Math.round(width)) < 0.01), 'score nomination widths align to physical pixels')
  assert.ok(physicalScoreModeGaps.every(gap => Math.abs(gap - Math.round(gap)) < 0.01), 'score nomination gaps align to physical pixels')
  assert.equal(new Set(physicalScoreModeGaps.map(gap => Math.round(gap))).size, 1, 'every score nomination gap renders at the same physical width')
  const scoreModeLabels = await page.locator('.analysis-score-modes span').allTextContents()
  assert.ok(!scoreModeLabels.includes('116'), 'non-dealer score modes exclude dealer-only 11,600 points')
  assert.ok(!scoreModeLabels.includes('117'), 'non-dealer score modes exclude dealer-only 11,700 points')
  const roomyOpponent = await opponentGeometry()
  assert.ok(roomyOpponent.doraHeight > 68, 'roomy opponent panel lets the dora distribution grow beyond its former cap')
  assert.ok(roomyOpponent.scoreHeight > 50, 'roomy opponent panel lets the score distribution grow beyond its former cap')
  assert.ok(Math.abs(roomyOpponent.unusedBottomHeight) < 1, 'opponent predictions consume the full remaining panel height')
  assert.equal(roomyOpponent.chartsStayInsideRows, true, 'expanded distributions stay inside their fixed prediction rows')
  assert.equal(
    await page.locator('.analysis-dora-distribution.has-reference-line, .analysis-score-distribution.has-reference-line').count(),
    0,
    '30% and 40% guide lines stay hidden while the default ranges are sufficient',
  )
  const baselineModeStrengths = await page.locator('.analysis-score-modes span').evaluateAll(elements => (
    elements.map(element => Number.parseFloat(getComputedStyle(element).getPropertyValue('--analysis-score-mode-strength')))
  ))
  assert.ok(baselineModeStrengths.every(Number.isFinite), 'each nominated score carries probability-derived background strength')
  const scoreCell = page.locator('.analysis-score-distribution .analysis-distribution-cell').first()
  await scoreCell.hover()
  await page.locator('.analysis-floating-tooltip').waitFor({ state: 'visible' })
  assert.equal(await scoreCell.evaluate(element => element.classList.contains('is-hovered')), true, 'the hovered score mode receives a visible row highlight')
  if (process.env.RMS_SCORE_HOVER_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_SCORE_HOVER_SCREENSHOT })
  }
  await page.mouse.move(0, 0)
  await page.waitForFunction(() => !document.querySelector('.analysis-floating-tooltip'))

  await page.evaluate(() => {
    const vm = window.analysisCheck.vm
    const result = window.analysisCheck.resultForNode(vm.gameView.currentNodeId, 1)
    for (const player of result.outputs['opponent-dora-count'].players) {
      player.prediction.distribution = [
        { value: 0, probability: 0.55 },
        { value: 1, probability: 0.2 },
        { value: 2, probability: 0.1 },
        { value: 3, probability: 0.07 },
        { value: 4, probability: 0.04 },
        { value: 5, probability: 0.02 },
        { value: 6, probability: 0.01 },
        { value: '7+', probability: 0.01 },
      ]
    }
    for (const player of result.outputs['opponent-score'].players) {
      player.prediction.distribution = [
        { value: 1000, probability: 0.62 },
        { value: 2000, probability: 0.2 },
        { value: 3900, probability: 0.1 },
        { value: 8000, probability: 0.08 },
      ]
    }
    window.analysisCheck.publish(result)
  })
  await page.waitForFunction(() => {
    const doraTrack = document.querySelector('.analysis-dora-distribution .analysis-distribution-track')
    const scoreTrack = document.querySelector('.analysis-score-distribution .analysis-distribution-track')
    return doraTrack && scoreTrack
      && Number.parseFloat(getComputedStyle(doraTrack, '::before').top) > 2
      && Number.parseFloat(getComputedStyle(scoreTrack, '::before').top) > 2
  })
  const adaptiveGuideRatios = await page.locator('.analysis-dora-distribution, .analysis-score-distribution').evaluateAll(charts => charts.slice(0, 2).map(chart => {
    const track = chart.querySelector('.analysis-distribution-track')
    const bounds = track?.getBoundingClientRect()
    return bounds ? Number.parseFloat(getComputedStyle(track, '::before').top) / bounds.height : -1
  }))
  assert.ok(Math.abs(adaptiveGuideRatios[0] - (1 - (0.4 / 0.55))) < 0.02, 'the 40% dora guide moves inside an expanded range')
  assert.ok(Math.abs(adaptiveGuideRatios[1] - (1 - (0.3 / 0.62))) < 0.02, 'the 30% score guide moves inside an expanded range')
  const adaptiveModeStrengths = await page.locator('.analysis-score-modes').first().locator('span').evaluateAll(elements => (
    elements.map(element => Number.parseFloat(getComputedStyle(element).getPropertyValue('--analysis-score-mode-strength')))
  ))
  assert.ok(adaptiveModeStrengths[0] > adaptiveModeStrengths[1] && adaptiveModeStrengths[1] > adaptiveModeStrengths[2], 'nominated score backgrounds preserve the probability ordering')
  assert.ok(adaptiveModeStrengths[0] - adaptiveModeStrengths[2] > 30, 'an extreme score prediction remains visibly distinct from lower nominations')
  if (process.env.RMS_OPPONENT_SCALE_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_OPPONENT_SCALE_SCREENSHOT })
  }

  const shantenSlice = page.locator('.shanten-chart path').first()
  await shantenSlice.hover()
  const shantenOutline = page.locator('.shanten-chart .shanten-hover-outline')
  await shantenOutline.waitFor({ state: 'visible' })
  assert.equal(await shantenOutline.getAttribute('d'), await shantenSlice.getAttribute('d'), 'the hovered shanten slice receives its own top-layer outline')
  assert.equal(await shantenSlice.locator('xpath=following-sibling::*[contains(@class, "shanten-hover-outline")]').count(), 1, 'the shanten hover outline paints after the data slices')
  assert.equal(await page.locator('.shanten-chart svg').first().evaluate(element => getComputedStyle(element).overflow), 'visible', 'shanten outlines are not clipped by the SVG viewport')
  if (process.env.RMS_SHANTEN_HOVER_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_SHANTEN_HOVER_SCREENSHOT })
  }
  await page.mouse.move(0, 0)
  await page.evaluate(() => {
    const vm = window.analysisCheck.vm
    window.analysisCheck.publish(window.analysisCheck.resultForNode(vm.gameView.currentNodeId, 1))
  })
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
  if (process.env.RMS_UI_PERFORMANCE_DIAGNOSTIC && process.env.RMS_UI_ELECTRON) {
    console.log(`Electron roomy risk geometry: ${JSON.stringify(roomyRisk)}`)
  }
  assert.equal(roomyRisk.rowWidths.length, 4)
  assert.ok(roomyRisk.rowWidths.every(width => Math.abs(width - roomyRisk.gridWidth) < 0.6), 'all four rows align to the panel width')
  assert.ok(Math.max(...roomyRisk.rowHeights) - Math.min(...roomyRisk.rowHeights) < 0.6, 'four rows share one visual ratio')
  assert.ok(Math.abs(roomyRisk.sequenceWidth - roomyRisk.faceWidth * 9) < 0.6, 'nine tile columns fill the chart lane')
  assert.ok(roomyRisk.barsHeight >= roomyRisk.faceHeight, 'bars retain at least one tile height')
  assert.ok(roomyRisk.barsHeight > roomyRisk.faceHeight * 1.15, 'bars expand into height not used by capped tiles')
  assert.ok(roomyRisk.scaleHeight > 0 && roomyRisk.scaleRight <= roomyRisk.gridRight + 0.6, 'the scale stays alongside the bars')
  assert.ok(roomyRisk.rowBorders.every(width => width === '0px'), 'risk rows have no divider rules')
  const riskLane = page.locator('.analysis-risk-bars > i').first()
  await riskLane.hover()
  assert.notEqual(await riskLane.evaluate(element => getComputedStyle(element, '::after').borderTopColor), 'rgba(0, 0, 0, 0)', 'the hovered deal-in lane receives the shared analysis highlight')
  await page.mouse.move(0, 0)

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
  const groupedCountLane = page.locator('.analysis-count-bars > button').first()
  await groupedCountLane.hover()
  assert.notEqual(await groupedCountLane.evaluate(element => getComputedStyle(element, '::after').borderTopColor), 'rgba(0, 0, 0, 0)', 'grouped count lanes receive the shared analysis highlight')
  await page.mouse.move(0, 0)
  if (process.env.RMS_SPLIT_UI_CHECK_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_SPLIT_UI_CHECK_SCREENSHOT })
  }

  // Every rendered tile face uses the table tile's material treatment. Contexts
  // may choose another size, but padding, corner radius and inset scale from the
  // same proportions instead of drifting into panel-specific approximations.
  await page.mouse.move(0, 0)
  await page.evaluate(() => { window.analysisCheck.vm.analysisCountLayout = 'source-rows' })
  await target().waitFor()
  const sourceLegendGeometry = await page.locator('.analysis-count-source-legend-group').evaluateAll(groups => groups.map((group) => {
    const label = group.querySelector('strong')?.getBoundingClientRect()
    const swatches = [...group.querySelectorAll('i')].map(swatch => swatch.getBoundingClientRect())
    return {
      labelToOwnSwatches: label && swatches.length ? swatches[0].left - label.right : Number.POSITIVE_INFINITY,
      internalSwatchGaps: swatches.slice(1).map((swatch, index) => swatch.left - swatches[index].right),
    }
  }))
  assert.equal(sourceLegendGeometry.length, 4, 'the source legend keeps one compact group for each source')
  assert.ok(sourceLegendGeometry.every(group => group.labelToOwnSwatches >= 0 && group.labelToOwnSwatches <= 5), 'each source label stays attached to its own color scale')
  assert.ok(sourceLegendGeometry.flatMap(group => group.internalSwatchGaps).every(gap => gap >= 0 && gap <= 4), 'each five-step color scale reads as one unit')
  if (process.env.RMS_COUNT_LEGEND_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_COUNT_LEGEND_SCREENSHOT })
  }
  await target().hover()
  await tooltip.waitFor({ state: 'visible' })
  assert.notEqual(await target().locator('.analysis-count-source-bar').evaluate(element => getComputedStyle(element, '::after').borderTopColor), 'rgba(0, 0, 0, 0)', 'the hovered count lane receives the shared analysis highlight')
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
  // A delayed navigation reply cannot restore a previous game, seat, or mode.
  await page.evaluate(async () => {
    const { vm } = window.analysisCheck
    const originalJump = window.studioAPI.jumpToNode
    for (const field of ['gameId', 'controlledSeat', 'mode']) {
      const state = JSON.parse(JSON.stringify(vm.status))
      const view = JSON.parse(JSON.stringify(vm.gameView))
      let resolve
      window.studioAPI.jumpToNode = () => new Promise(done => { resolve = done })
      const pending = vm.jumpToNode('delayed-node')
      if (field === 'gameId') vm.gameView.gameId = 'replacement-game'
      if (field === 'controlledSeat') vm.status.controlledSeat = (state.controlledSeat + 1) % 4
      if (field === 'mode') vm.status.mode = state.mode === 'research' ? 'play' : 'research'
      resolve({ state, view: { ...view, currentNodeId: 'delayed-node' } })
      await pending
      if (vm.gameView.currentNodeId === 'delayed-node') throw new Error(`Stale navigation accepted after ${field} changed`)
      if (field === 'gameId' && vm.gameView.gameId !== 'replacement-game') throw new Error('Old game restored')
      if (field === 'controlledSeat' && vm.status.controlledSeat === state.controlledSeat) throw new Error('Old seat restored')
      if (field === 'mode' && vm.status.mode === state.mode) throw new Error('Old mode restored')
      vm.gameView.gameId = view.gameId
      vm.status.controlledSeat = state.controlledSeat
      vm.status.mode = state.mode
    }
    window.studioAPI.jumpToNode = originalJump
  })

  // Label measurements must survive mounting, resizing, and new probabilities.
  await page.setViewportSize({ width: 1400, height: 1000 })
  await page.evaluate(() => {
    const { vm } = window.analysisCheck
    vm.settings.display.workspaceLayout = {
      ...vm.workspaceLayout,
      analysisVisible: true, consoleVisible: false,
      layout: {
        type: 'split', direction: 'horizontal', weights: [1, 1],
        children: [{ type: 'item', id: 'table' }, { type: 'item', id: 'analysis-game' }],
      },
      analysisPanels: { opponents: false, game: true, risk: false, counts: false },
    }
    const result = window.analysisCheck.result()
    result.outputs['kyoku-outcome'] = {
      players: [
        { seat: 0, winProbability: 0.01, dealInProbability: 0.95 },
        { seat: 1, winProbability: 0.95, dealInProbability: 0.01 },
        { seat: 2, winProbability: 0.5, dealInProbability: 0.5 },
        { seat: 3, winProbability: 1, dealInProbability: 0 },
      ],
    }
    window.analysisCheck.publish(result)
  })
  for (const width of [1400, 1000, 1400]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.waitForFunction(() => {
      const tracks = [...document.querySelectorAll('.analysis-offense-track.labels-measured')]
      return tracks.length === 4 && tracks.every(track => {
        const bounds = track.getBoundingClientRect()
        const left = track.querySelector('.is-deal-in.analysis-offense-value').getBoundingClientRect()
        const right = track.querySelector('.is-win.analysis-offense-value').getBoundingClientRect()
        return left.left >= bounds.left - 1 && right.right <= bounds.right + 1 && left.right + 4 <= right.left
      })
    })
  }

  // Mutually exclusive outcome details share one 100% stacked bar. The rows
  // below it identify segments and preserve exact values without separate bars.
  await page.evaluate(() => {
    const { vm } = window.analysisCheck
    vm.settings.display.language = 'zh-CN'
    const result = window.analysisCheck.result()
    result.outputs['kyoku-outcome'] = {
      outcomes: [
        { type: 'draw', probability: 0.10 },
        { type: 'tsumo', winner: 0, probability: 0.10 },
        { type: 'ron', winners: [1], target: 0, probability: 0.28 },
        { type: 'ron', winners: [2], target: 0, probability: 0.20 },
        { type: 'ron', winners: [3], target: 0, probability: 0.17 },
        { type: 'ron', winners: [1, 2], target: 0, probability: 0.07 },
        { type: 'ron', winners: [1, 3], target: 0, probability: 0.05 },
        { type: 'ron', winners: [2, 3], target: 0, probability: 0.03 },
      ],
    }
    result.outputs['match-placement'] = {
      players: [0, 1, 2, 3].map(seat => ({
        seat,
        prediction: {
          expectedValue: 2.1,
          distribution: [
            { value: 4, probability: 0.05 },
            { value: 3, probability: 0.15 },
            { value: 2, probability: 0.30 },
            { value: 1, probability: 0.50 },
          ],
        },
      })),
    }
    window.analysisCheck.publish(result)
  })
  const selfDealInSegment = page.locator('.analysis-offense-row').first().locator('.analysis-offense-segment.is-deal-in')
  await selfDealInSegment.hover()
  const selfOffenseTrack = page.locator('.analysis-offense-row').first().locator('.analysis-offense-track')
  const dealInHoverGeometry = await selfOffenseTrack.evaluate((element) => ({
    trackWidth: element.getBoundingClientRect().width,
    hoverWidth: Number.parseFloat(getComputedStyle(element, '::after').width),
  }))
  assert.ok(Math.abs(dealInHoverGeometry.hoverWidth - (dealInHoverGeometry.trackWidth * 0.8)) < 1, 'deal-in hover covers only the actual probability bar')
  if (process.env.RMS_OFFENSE_HOVER_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_OFFENSE_HOVER_SCREENSHOT })
  }
  const outcomeTooltip = page.locator('.analysis-floating-tooltip.is-outcome-detail')
  await outcomeTooltip.waitFor({ state: 'visible' })
  const outcomeTooltipGeometry = await outcomeTooltip.evaluate((element) => {
    const bar = element.querySelector('.analysis-outcome-detail-bar')
    const rows = [...element.querySelectorAll('.ui-hover-tooltip-row.has-segment')]
    const segments = [...(bar?.children || [])].map(segment => segment.getBoundingClientRect())
    const values = rows.map(row => row.lastElementChild?.getBoundingClientRect()).filter(Boolean)
    return {
      rowCount: rows.length,
      barCount: element.querySelectorAll('.analysis-outcome-detail-bar').length,
      barWidth: bar?.getBoundingClientRect().width || 0,
      segmentWidths: segments.map(segment => segment.width),
      labels: rows.map(row => row.firstElementChild?.textContent || ''),
      swatchCount: element.querySelectorAll('.analysis-outcome-detail-swatch').length,
      valueRightEdges: values.map(value => value.right),
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }
  })
  assert.equal(outcomeTooltipGeometry.rowCount, 6, 'all mutually exclusive deal-in details remain visible')
  assert.equal(outcomeTooltipGeometry.barCount, 1, 'mutually exclusive details share one probability bar')
  assert.ok(Math.abs(outcomeTooltipGeometry.segmentWidths.reduce((sum, width) => sum + width, 0) - outcomeTooltipGeometry.barWidth) < 1, 'outcome segments fill one 100% bar')
  assert.ok(outcomeTooltipGeometry.segmentWidths[0] > outcomeTooltipGeometry.segmentWidths[1], 'segment widths preserve the probability ordering')
  assert.equal(outcomeTooltipGeometry.swatchCount, 6, 'each detail row identifies its segment')
  assert.ok(outcomeTooltipGeometry.labels.some(label => label.includes('＋')), 'multiple winners are shown as a concise combination')
  assert.ok(Math.max(...outcomeTooltipGeometry.valueRightEdges) - Math.min(...outcomeTooltipGeometry.valueRightEdges) < 0.6, 'exact probability values share one right edge')
  assert.ok(outcomeTooltipGeometry.scrollWidth <= outcomeTooltipGeometry.clientWidth + 1, 'outcome detail rows do not overflow the tooltip')
  if (process.env.RMS_OUTCOME_TOOLTIP_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_OUTCOME_TOOLTIP_SCREENSHOT })
  }
  await page.mouse.move(0, 0)
  await page.waitForFunction(() => !document.querySelector('.analysis-floating-tooltip'))

  const placementBar = page.locator('.analysis-placement-bar').first()
  const placementSegments = placementBar.locator(':scope > span')
  assert.equal(await placementSegments.count(), 4)
  assert.equal(await placementSegments.nth(0).locator('small').count(), 0, 'a placement segment without enough probability share omits its label')
  assert.equal(await placementBar.locator('small').count(), 3, 'roomy placement segments display their percentages directly')
  const placementLabelGeometry = await placementBar.locator('small').evaluateAll(labels => labels.map(label => {
    const labelBounds = label.getBoundingClientRect()
    const segmentBounds = label.parentElement.getBoundingClientRect()
    return {
      left: labelBounds.left,
      right: labelBounds.right,
      segmentLeft: segmentBounds.left,
      segmentRight: segmentBounds.right,
    }
  }))
  assert.ok(placementLabelGeometry.every(item => item.left >= item.segmentLeft - 0.6 && item.right <= item.segmentRight + 0.6), 'placement percentages stay inside their segments')

  const highlightChecks = [
    { hover: page.locator('.analysis-outcome-bar > span').first(), surface: page.locator('.analysis-outcome-bar > span').first() },
    { hover: page.locator('.analysis-offense-row').first().locator('.analysis-offense-segment.is-deal-in'), surface: page.locator('.analysis-offense-row').first().locator('.analysis-offense-track') },
    { hover: page.locator('.analysis-delta-cell').first(), surface: page.locator('.analysis-delta-cell').first() },
    { hover: placementBar, surface: placementBar },
  ]
  for (const { hover, surface } of highlightChecks) {
    await hover.hover()
    assert.notEqual(await surface.evaluate(element => getComputedStyle(element, '::after').borderTopColor), 'rgba(0, 0, 0, 0)', 'interactive game-analysis bars share the same hover feedback')
  }
  if (process.env.RMS_ANALYSIS_HOVER_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_ANALYSIS_HOVER_SCREENSHOT })
  }
  await page.mouse.move(0, 0)
  }

  // A cached node change lets table motion finish before the complete next
  // analysis presentation is committed. The opt-in realistic diagnostic uses
  // the public example's full outputs and all four analysis panels.
  await page.setViewportSize(realisticPerformance
    ? { width: 2560, height: 1392 }
    : { width: 1400, height: 1000 })
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.count-prediction-tooltip, .analysis-floating-tooltip'))
  await page.evaluate(() => {
    const check = window.analysisCheck
    const { vm } = check
    const hand = ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p', '5p']
    vm.gameView.table.hands[vm.status.controlledSeat] = hand
    vm.gameView.legalActions = hand.map((pai, index) => ({
      id: `discard-${index}`,
      type: 'dahai',
      actor: vm.status.controlledSeat,
      pai,
      tsumogiri: index === hand.length - 1,
      label: pai,
    }))
    vm.gameView.analysis = {
      model: 'ui-test-decision',
      seat: vm.status.controlledSeat,
      discardEntries: hand.map((pai, index) => ({
        candidateId: `discard-${index}`,
        pai,
        tsumogiri: index === hand.length - 1,
        value: index / hand.length,
        probability: (index + 1) / hand.length,
        bar: (index + 1) / hand.length,
        isBest: index === hand.length - 1,
      })),
    }
    const realisticInitial = check.realisticResultForNode(0, vm.gameView.currentNodeId)
    const initial = realisticInitial || check.resultForNode(vm.gameView.currentNodeId, 1)
    check.publish(initial)
    vm.settings.display.workspaceLayout = realisticInitial
      ? {
          ...vm.workspaceLayout,
          analysisVisible: true,
          consoleVisible: false,
          layout: {
            type: 'split', direction: 'horizontal', weights: [2.2, 1, 1],
            children: [
              { type: 'item', id: 'table' },
              { type: 'split', direction: 'vertical', weights: [1, 1], children: [
                { type: 'item', id: 'analysis-opponents' },
                { type: 'item', id: 'analysis-risk' },
              ] },
              { type: 'split', direction: 'vertical', weights: [1.4, 1], children: [
                { type: 'item', id: 'analysis-counts' },
                { type: 'item', id: 'analysis-game' },
              ] },
            ],
          },
          analysisPanels: { opponents: true, game: true, risk: true, counts: true },
        }
      : {
          ...vm.workspaceLayout,
          analysisVisible: true,
          consoleVisible: false,
          layout: {
            type: 'split', direction: 'horizontal', weights: [2, 1],
            children: [
              { type: 'item', id: 'table' },
              { type: 'split', direction: 'vertical', weights: [1, 1], children: [
                { type: 'item', id: 'analysis-opponents' },
                { type: 'item', id: 'analysis-risk' },
              ] },
            ],
          },
          analysisPanels: { opponents: true, game: false, risk: true, counts: false },
        }
  })
  await page.locator('.shanten-chart path').first().waitFor()
  await page.locator('.analysis-risk-row-canvas').first().waitFor()
  if (realisticPerformance) {
    await page.locator('.analysis-count-grid').waitFor()
    await page.locator('.analysis-player-section').waitFor()
  }
  await page.locator('.grid-main .choice-bar-fill').first().waitFor()
  await page.locator('.grid-main .table-ron-risk-canvas').waitFor()
  await page.waitForTimeout(200)
  const permanentLayerHints = await page.evaluate(() => [
    ...document.querySelectorAll('.grid-main .tileImg:not(.discard-flight-back), .grid-main .choice-bar-fill'),
  ].filter(element => getComputedStyle(element).willChange.includes('transform')).length)
  assert.equal(permanentLayerHints, 0, 'repeated table primitives do not reserve permanent compositor layers')
  const analysisCssMotionDisabled = Boolean(process.env.RMS_UI_EXPERIMENT_NO_ANALYSIS_CSS_MOTION)
  if (analysisCssMotionDisabled) {
    await page.addStyleTag({ content: '.analysis-panel-live * { transition-duration: 0s !important; }' })
  }
  const analysisMotionExperiment = analysisCssMotionDisabled
  const cdpSession = await page.context().newCDPSession(page)
  await cdpSession.send('Performance.enable')
  const traceEnabled = Boolean(process.env.RMS_UI_TRACE)
  let traceComplete
  if (traceEnabled) {
    traceComplete = new Promise(resolve => cdpSession.once('Tracing.tracingComplete', resolve))
    await cdpSession.send('Tracing.start', {
      categories: [
        'blink',
        'cc',
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'disabled-by-default-devtools.timeline.frame',
        'gpu',
      ].join(','),
      transferMode: 'ReturnAsStream',
    })
  }
  const performanceBefore = await cdpSession.send('Performance.getMetrics')
  const navigationMotion = await page.evaluate(async (collectMotionSamples) => {
    const check = window.analysisCheck
    const { vm } = check
    const originalJump = window.studioAPI.jumpToNode
    const originalRead = window.studioAPI.getAnalysis
    const nextNodeId = `${vm.gameView.currentNodeId}-performance`
    const nextResult = check.realisticResultForNode(1, nextNodeId) || check.resultForNode(nextNodeId, 2)
    window.studioAPI.getAnalysis = async () => nextResult
    window.studioAPI.jumpToNode = async () => {
      const view = JSON.parse(JSON.stringify(vm.gameView))
      view.currentNodeId = nextNodeId
      view.opponentAnalysis = nextResult
      const actor = vm.status.controlledSeat
      const pai = view.table.hands[actor].at(-1)
      view.table.hands[actor] = view.table.hands[actor].slice(0, -1)
      view.table.rivers[actor] = [...view.table.rivers[actor], pai]
      view.table.pendingDiscard = { actor, pai, tsumogiri: true, targetActor: actor }
      view.analysis.discardEntries = view.analysis.discardEntries.map((entry, index, entries) => ({
        ...entry,
        value: (entries.length - index) / entries.length,
        probability: (entries.length - index) / entries.length,
        bar: (entries.length - index) / entries.length,
        isBest: index === 0,
      }))
      return { state: JSON.parse(JSON.stringify(vm.status)), view }
    }
    const frameTimes = []
    const longTasks = []
    const tableMotionSamples = []
    const analysisMotionSamples = []
    const captureDistributionGeometry = () => {
      const distributions = [...document.querySelectorAll(
        '.analysis-panel-live .analysis-dora-distribution, .analysis-panel-live .analysis-score-distribution',
      )]
      const tracks = [...document.querySelectorAll('.analysis-panel-live .analysis-distribution-track')]
      const canvases = [...document.querySelectorAll('.analysis-panel-live .analysis-distribution-canvas')]
      return {
        distributionHeights: distributions.map(element => element.getBoundingClientRect().height),
        trackHeights: tracks.map(element => element.getBoundingClientRect().height),
        bottomOverflow: canvases.map((canvas) => {
          const canvasRect = canvas.getBoundingClientRect()
          const distributionRect = canvas.parentElement?.getBoundingClientRect()
          return distributionRect ? canvasRect.bottom - distributionRect.bottom : 0
        }),
        renderSignatures: canvases.map(canvas => canvas.rmsDistributionRenderSignature || ''),
      }
    }
    const captureTableRonRiskGeometry = () => {
      const root = document.querySelector('.grid-main .ron-risk-bars')
      const canvas = root?.querySelector('.table-ron-risk-canvas')
      if (!(root instanceof HTMLElement) || !(canvas instanceof HTMLCanvasElement)) return null
      const rootRect = root.getBoundingClientRect()
      const canvasRect = canvas.getBoundingClientRect()
      return {
        rootHeight: rootRect.height,
        canvasHeight: canvasRect.height,
        overflow: {
          top: rootRect.top - canvasRect.top,
          right: canvasRect.right - rootRect.right,
          bottom: canvasRect.bottom - rootRect.bottom,
          left: rootRect.left - canvasRect.left,
        },
        renderSignature: canvas.rmsRonRiskRenderSignature || '',
      }
    }
    const captureCountCanvasSignature = () => [
      ...document.querySelectorAll(
        '.analysis-count-source-row-canvas, .analysis-count-row-canvas',
      ),
    ].map(canvas => canvas.rmsCountRenderSignature || '').join('|')
    const oldPiePath = document.querySelector('.analysis-panel-live .shanten-chart path')?.getAttribute('d') || ''
    const oldRiskCanvas = document.querySelector('.analysis-panel-live .analysis-risk-row-canvas')?.rmsRiskRenderSignature || ''
    const oldCountCanvas = captureCountCanvasSignature()
    const frameSample = new Promise(resolve => {
      const startedAt = performance.now()
      const observer = typeof PerformanceObserver === 'function'
        ? new PerformanceObserver(list => {
            longTasks.push(...list.getEntries().map(entry => ({ startTime: entry.startTime, duration: entry.duration })))
          })
        : null
      try { observer?.observe({ type: 'longtask' }) } catch { /* unsupported */ }
      const sample = timestamp => {
        frameTimes.push(timestamp)
        if (collectMotionSamples) {
          const activeAnimations = document.getAnimations().filter(animation => animation.playState !== 'finished')
          const tableAnimation = activeAnimations.find(animation => (
            animation.effect?.target instanceof Element
            && Boolean(animation.effect.target.closest('.grid-main'))
          ))
          if (tableAnimation && typeof tableAnimation.currentTime === 'number') {
            tableMotionSamples.push({ timestamp, currentTime: tableAnimation.currentTime })
          }
          const analysisAnimation = activeAnimations.find(animation => (
            animation.effect?.target instanceof Element
            && Boolean(animation.effect.target.closest('.analysis-panel-live'))
          ))
          const riskSignature = document.querySelector('.analysis-panel-live .analysis-risk-row-canvas')?.rmsRiskRenderSignature || ''
          const countSignature = captureCountCanvasSignature()
          if (analysisAnimation && typeof analysisAnimation.currentTime === 'number') {
            analysisMotionSamples.push({ timestamp, currentTime: analysisAnimation.currentTime, riskSignature, countSignature })
          } else if ((riskSignature && riskSignature !== oldRiskCanvas) || (countSignature && countSignature !== oldCountCanvas)) {
            analysisMotionSamples.push({ timestamp, currentTime: null, riskSignature, countSignature })
          }
        }
        if (timestamp - startedAt < 300) requestAnimationFrame(sample)
        else {
          observer?.disconnect()
          resolve({ startedAt, frameTimes, longTasks })
        }
      }
      requestAnimationFrame(sample)
    })
    const distributionBefore = captureDistributionGeometry()
    const tableRonRiskBefore = captureTableRonRiskGeometry()
    await vm.jumpToNode(nextNodeId)
    const immediatePiePath = document.querySelector('.analysis-panel-live .shanten-chart path')?.getAttribute('d') || ''
    const tablePhasePromise = new Promise(resolve => setTimeout(() => {
      const activeAnimations = document.getAnimations().filter(animation => animation.playState !== 'finished')
      resolve({
        tableAnimations: activeAnimations.filter(animation => (
          animation.effect?.target instanceof Element
          && Boolean(animation.effect.target.closest('.grid-main'))
        )).length,
        analysisAnimations: activeAnimations.filter(animation => (
          animation.effect?.target instanceof Element
          && Boolean(animation.effect.target.closest('.analysis-panel-live'))
        )).length,
      })
    }, 70))
    const duringPromise = new Promise(resolve => setTimeout(() => {
      const animatedTargets = document.getAnimations()
        .filter(animation => animation.playState !== 'finished')
        .map(animation => animation.effect?.target)
      const analysisDataAnimations = animatedTargets
        .filter(target => target instanceof Element && Boolean(target.closest('.analysis-panel-live')))
      const tableDataAnimations = animatedTargets
        .filter(target => target instanceof Element && Boolean(target.closest('.grid-main')))
      const describeAnimationTargets = targets => Object.entries(targets.reduce((counts, target) => {
        const key = target.classList.length ? [...target.classList].join('.') : target.tagName.toLowerCase()
        counts[key] = (counts[key] || 0) + 1
        return counts
      }, {})).sort((left, right) => right[1] - left[1])
      const animationTargets = describeAnimationTargets(analysisDataAnimations)
      const transitionDurations = [
        ...document.querySelectorAll(
          '.analysis-panel-live .analysis-outcome-bar > span, '
          + '.analysis-panel-live .analysis-offense-segment, '
          + '.analysis-panel-live .analysis-offense-value, '
          + '.analysis-panel-live .analysis-delta-cell > span, '
          + '.analysis-panel-live .analysis-placement-bar > span',
        ),
      ].map(element => getComputedStyle(element).transitionDuration)
      resolve({
        tableSuppressed: document.querySelector('.grid-main')?.classList.contains('reset-without-motion') || false,
        panelsSuppressed: [...document.querySelectorAll('.analysis-panel-content')]
          .every(element => element.classList.contains('reduce-motion')),
        analysisDataAnimationCount: analysisDataAnimations.length,
        animationTargets,
        tableDataAnimationCount: tableDataAnimations.length,
        tableAnimationTargets: describeAnimationTargets(tableDataAnimations),
        transitionDurations,
        piePath: document.querySelector('.analysis-panel-live .shanten-chart path')?.getAttribute('d') || '',
        riskCanvas: document.querySelector('.analysis-panel-live .analysis-risk-row-canvas')?.rmsRiskRenderSignature || '',
        countCanvas: captureCountCanvasSignature(),
        distributionGeometry: captureDistributionGeometry(),
        tableRonRiskGeometry: captureTableRonRiskGeometry(),
      })
    }, 210))
    const [tablePhase, during] = await Promise.all([tablePhasePromise, duringPromise])
    const after = await new Promise(resolve => setTimeout(() => {
      resolve({
        activeDataAnimations: document.getAnimations().filter(animation => (
          animation.playState !== 'finished'
          && animation.effect?.target instanceof Element
          && Boolean(animation.effect.target.closest('.analysis-panel-live'))
        )).length,
        piePath: document.querySelector('.analysis-panel-live .shanten-chart path')?.getAttribute('d') || '',
        riskCanvas: document.querySelector('.analysis-panel-live .analysis-risk-row-canvas')?.rmsRiskRenderSignature || '',
        countCanvas: captureCountCanvasSignature(),
        distributionGeometry: captureDistributionGeometry(),
        tableRonRiskGeometry: captureTableRonRiskGeometry(),
      })
    }, 140))
    window.studioAPI.jumpToNode = originalJump
    window.studioAPI.getAnalysis = originalRead
    const samples = await frameSample
    const sampleEndedAt = samples.frameTimes.at(-1) || performance.now()
    const frameIntervals = samples.frameTimes.slice(1).map((time, index) => time - samples.frameTimes[index])
    const motionFrameIntervals = samples.frameTimes
      .slice(1)
      .filter(time => time - samples.startedAt <= 110)
      .map((time, index) => time - samples.frameTimes[index])
    return {
      oldPiePath,
      oldRiskCanvas,
      oldCountCanvas,
      immediatePiePath,
      distributionBefore,
      tableRonRiskBefore,
      tablePhase,
      during,
      after,
      performance: {
        frameCount: samples.frameTimes.length,
        motionFrameCount: motionFrameIntervals.length,
        medianFrameInterval: frameIntervals.slice().sort((a, b) => a - b)[Math.floor(frameIntervals.length / 2)] || null,
        worstFrameInterval: frameIntervals.length ? Math.max(...frameIntervals) : null,
        worstMotionFrameInterval: motionFrameIntervals.length ? Math.max(...motionFrameIntervals) : null,
        delayedFrames: frameIntervals.map((interval, index) => ({
          interval,
          elapsed: samples.frameTimes[index + 1] - samples.startedAt,
        })).filter(sample => sample.interval > 20),
        longTasks: samples.longTasks.filter(task => (
          task.startTime >= samples.startedAt && task.startTime <= sampleEndedAt
        )),
        tableMotionSamples,
        analysisMotionSamples,
      },
    }
  }, Boolean(process.env.RMS_UI_PERFORMANCE_DIAGNOSTIC || realisticPerformance))
  const performanceAfter = await cdpSession.send('Performance.getMetrics')
  let traceSummary = null
  if (traceEnabled) {
    await cdpSession.send('Tracing.end')
    const { stream } = await traceComplete
    let traceJson = ''
    for (;;) {
      const chunk = await cdpSession.send('IO.read', { handle: stream })
      traceJson += chunk.data
      if (chunk.eof) break
    }
    await cdpSession.send('IO.close', { handle: stream })
    const traceEvents = JSON.parse(traceJson).traceEvents || []
    const durations = traceEvents.filter(event => event.ph === 'X' && Number(event.dur) > 0)
    const totals = new Map()
    for (const event of durations) {
      const current = totals.get(event.name) || { name: event.name, totalMs: 0, maxMs: 0, count: 0 }
      const durationMs = Number(event.dur) / 1000
      current.totalMs += durationMs
      current.maxMs = Math.max(current.maxMs, durationMs)
      current.count += 1
      totals.set(event.name, current)
    }
    traceSummary = {
      topByTotal: [...totals.values()].sort((left, right) => right.totalMs - left.totalMs).slice(0, 24),
      longestEvents: durations
        .map(event => ({ name: event.name, durationMs: Number(event.dur) / 1000, thread: event.tid }))
        .filter(event => event.durationMs >= 4)
        .sort((left, right) => right.durationMs - left.durationMs)
        .slice(0, 24),
    }
  }
  const beforeMetrics = Object.fromEntries(performanceBefore.metrics.map(({ name, value }) => [name, value]))
  const performanceDelta = Object.fromEntries([
    'LayoutCount',
    'RecalcStyleCount',
    'LayoutDuration',
    'RecalcStyleDuration',
    'ScriptDuration',
    'TaskDuration',
    'JSHeapUsedSize',
  ].map((name) => {
    const nextValue = performanceAfter.metrics.find((metric) => metric.name === name)?.value || 0
    return [name, nextValue - (beforeMetrics[name] || 0)]
  }))
  await cdpSession.detach()
  assert.equal(navigationMotion.immediatePiePath, navigationMotion.oldPiePath, 'cached analysis waits until table motion has finished')
  assert.ok(navigationMotion.tablePhase.tableAnimations > 0, 'the representative navigation runs real table motion')
  assert.equal(navigationMotion.tablePhase.analysisAnimations, 0, 'analysis feedback does not overlap the table motion window')
  assert.equal(navigationMotion.during.tableSuppressed, false, 'ordinary table motion remains available during navigation')
  assert.equal(navigationMotion.during.panelsSuppressed, false, 'ordinary analysis feedback remains available during navigation')
  if (process.env.RMS_UI_PERFORMANCE_DIAGNOSTIC) {
    const durationCounts = navigationMotion.during.transitionDurations.reduce((counts, duration) => {
      counts[duration] = (counts[duration] || 0) + 1
      return counts
    }, {})
    console.log('Navigation motion:', JSON.stringify({
      ...navigationMotion.during,
      transitionDurations: durationCounts,
    }))
  }
  if (!analysisMotionExperiment) {
    assert.ok(
      navigationMotion.during.analysisDataAnimationCount > 0
        || navigationMotion.during.riskCanvas !== navigationMotion.oldRiskCanvas,
      'analysis values animate after the table motion window',
    )
    assert.ok(
      navigationMotion.during.transitionDurations.every(duration => duration === '0.11s'),
      'CSS prediction primitives use the established 110ms motion duration',
    )
  }
  assert.equal(navigationMotion.after.activeDataAnimations, 0, 'analysis value motion finishes within the shared motion duration')
  assert.deepEqual(
    navigationMotion.during.distributionGeometry.distributionHeights,
    navigationMotion.distributionBefore.distributionHeights,
    'dora distribution height remains fixed while its values animate',
  )
  assert.deepEqual(
    navigationMotion.after.distributionGeometry.distributionHeights,
    navigationMotion.distributionBefore.distributionHeights,
    'dora distribution height remains fixed after its values settle',
  )
  assert.deepEqual(
    navigationMotion.during.distributionGeometry.trackHeights,
    navigationMotion.distributionBefore.trackHeights,
    'every dora and score track keeps its allocated height while values animate',
  )
  assert.deepEqual(
    navigationMotion.after.distributionGeometry.trackHeights,
    navigationMotion.distributionBefore.trackHeights,
    'every dora and score track keeps its allocated height after values settle',
  )
  assert.ok(
    navigationMotion.during.distributionGeometry.bottomOverflow.every(value => Math.abs(value) < 0.01),
    'dora fills remain clipped to the fixed track during animation',
  )
  assert.notDeepEqual(
    navigationMotion.after.distributionGeometry.renderSignatures,
    navigationMotion.distributionBefore.renderSignatures,
    'fixed dora and score canvases draw the next distribution instead of retaining stale pixels',
  )
  assert.equal(
    navigationMotion.during.tableRonRiskGeometry.rootHeight,
    navigationMotion.tableRonRiskBefore.rootHeight,
    'table deal-in bar height remains fixed while its values animate',
  )
  assert.equal(
    navigationMotion.after.tableRonRiskGeometry.rootHeight,
    navigationMotion.tableRonRiskBefore.rootHeight,
    'table deal-in bar height remains fixed after its values settle',
  )
  assert.deepEqual(
    navigationMotion.during.tableRonRiskGeometry.overflow,
    { top: 0, right: 0, bottom: 0, left: 0 },
    'table deal-in drawing remains clipped to its fixed layout box',
  )
  assert.notEqual(
    navigationMotion.after.tableRonRiskGeometry.renderSignature,
    navigationMotion.tableRonRiskBefore.renderSignature,
    'table deal-in canvas draws the next probabilities instead of retaining stale pixels',
  )
  assert.notEqual(navigationMotion.after.piePath, navigationMotion.during.piePath, 'the shanten chart interpolates its values instead of replacing the pie at once')
  assert.notEqual(navigationMotion.after.riskCanvas, navigationMotion.oldRiskCanvas, 'the deal-in chart draws the next values on its fixed canvas')
  if (realisticPerformance) {
    assert.notEqual(navigationMotion.after.countCanvas, navigationMotion.oldCountCanvas, 'the count chart draws the next distributions on its fixed canvas')
    assert.ok(
      new Set(navigationMotion.performance.analysisMotionSamples.map(sample => sample.countSignature).filter(Boolean)).size >= 3,
      'count distributions interpolate through multiple visible frames instead of jumping to the next result',
    )
  }
  assert.equal(
    await page.locator('body').evaluate(element => getComputedStyle(element).getPropertyValue('--ui-motion-duration').trim()),
    '110ms',
    'the shared UI motion duration remains 110ms',
  )
  assert.equal(
    await page.locator('body').evaluate(element => getComputedStyle(element).getPropertyValue('--ui-motion-easing').trim()),
    'cubic-bezier(0.33, 1, 0.68, 1)',
    'the shared UI motion keeps the established fast-out easing curve',
  )
  assert.equal(
    await page.locator('.grid-main .choice-bar-fill').first().evaluate(element => getComputedStyle(element).transitionDuration),
    '0.11s',
    'table recommendation bars use the established 110ms motion duration',
  )
  if (process.env.RMS_UI_PERFORMANCE_DIAGNOSTIC) {
    console.log(`Frame-switch performance: ${JSON.stringify(navigationMotion.performance)}`)
    console.log(`Frame-switch browser work: ${JSON.stringify(performanceDelta)}`)
    if (traceSummary) console.log(`Frame-switch trace: ${JSON.stringify(traceSummary)}`)
  }
  if (process.env.RMS_UI_PERFORMANCE_SCREENSHOT) {
    await page.screenshot({ path: path.resolve(process.env.RMS_UI_PERFORMANCE_SCREENSHOT) })
  }

  const stressSwitches = Math.max(0, Math.floor(Number(process.env.RMS_UI_STRESS_SWITCHES) || 0))
  if (stressSwitches) {
    const stressPerformance = await page.evaluate(async (switchCount) => {
      const check = window.analysisCheck
      const { vm } = check
      const originalJump = window.studioAPI.jumpToNode
      const originalRead = window.studioAPI.getAnalysis
      const baseView = JSON.parse(JSON.stringify(vm.gameView))
      const baseStatus = JSON.parse(JSON.stringify(vm.status))
      const actor = vm.status.controlledSeat
      const hand = ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p', '5p']
      const frameTimes = []
      const longTasks = []
      const applyDurations = []
      const firstFrameDurations = []
      let maximumActiveAnimations = 0
      let sampling = true
      const observer = typeof PerformanceObserver === 'function'
        ? new PerformanceObserver(list => {
            longTasks.push(...list.getEntries().map(entry => ({
              startTime: entry.startTime,
              duration: entry.duration,
            })))
          })
        : null
      try { observer?.observe({ type: 'longtask' }) } catch { /* unsupported */ }
      const sampleFrame = (timestamp) => {
        frameTimes.push(timestamp)
        maximumActiveAnimations = Math.max(
          maximumActiveAnimations,
          document.getAnimations().filter(animation => animation.playState !== 'finished').length,
        )
        if (sampling) requestAnimationFrame(sampleFrame)
      }
      requestAnimationFrame(sampleFrame)
      const heapBefore = performance.memory?.usedJSHeapSize ?? null
      try {
        for (let index = 0; index < switchCount; index += 1) {
          const nodeId = `stress-node-${index}`
          const result = check.realisticResultForNode(index % 2, nodeId)
            || check.resultForNode(nodeId, (index % 3) + 1)
          window.studioAPI.getAnalysis = async () => result
          window.studioAPI.jumpToNode = async () => {
            const view = structuredClone(baseView)
            view.currentNodeId = nodeId
            view.opponentAnalysis = result
            view.table.hands[actor] = hand.slice(0, -1)
            view.table.rivers[actor] = [...(view.table.rivers[actor] || []), hand.at(-1)]
            view.table.pendingDiscard = {
              actor,
              pai: hand.at(-1),
              tsumogiri: true,
              targetActor: actor,
            }
            return { state: structuredClone(baseStatus), view }
          }
          const startedAt = performance.now()
          await vm.jumpToNode(nodeId)
          applyDurations.push(performance.now() - startedAt)
          const firstFrameAt = await new Promise(resolve => requestAnimationFrame(resolve))
          firstFrameDurations.push(firstFrameAt - startedAt)
          await new Promise(resolve => setTimeout(resolve, 250))
        }
      } finally {
        window.studioAPI.jumpToNode = originalJump
        window.studioAPI.getAnalysis = originalRead
        sampling = false
        await new Promise(resolve => requestAnimationFrame(resolve))
        observer?.disconnect()
      }
      const intervals = frameTimes.slice(1).map((time, index) => time - frameTimes[index])
      const orderedApply = [...applyDurations].sort((left, right) => left - right)
      const orderedFirstFrame = [...firstFrameDurations].sort((left, right) => left - right)
      const activeAnimationsImmediatelyAfter = document.getAnimations()
        .filter(animation => animation.playState !== 'finished').length
      await new Promise(resolve => setTimeout(resolve, 300))
      return {
        switchCount,
        frameCount: frameTimes.length,
        medianFrameInterval: intervals.slice().sort((left, right) => left - right)[Math.floor(intervals.length / 2)] || null,
        worstFrameInterval: intervals.length ? Math.max(...intervals) : null,
        intervalsOver50ms: intervals.filter(interval => interval > 50),
        longTasks,
        applyMs: {
          median: orderedApply[Math.floor(orderedApply.length / 2)] || null,
          p95: orderedApply[Math.floor(orderedApply.length * 0.95)] || null,
          max: orderedApply.at(-1) || null,
        },
        firstFrameMs: {
          median: orderedFirstFrame[Math.floor(orderedFirstFrame.length / 2)] || null,
          p95: orderedFirstFrame[Math.floor(orderedFirstFrame.length * 0.95)] || null,
          max: orderedFirstFrame.at(-1) || null,
        },
        maximumActiveAnimations,
        activeAnimationsImmediatelyAfter,
        activeAnimationsAfterSettling: document.getAnimations().filter(animation => animation.playState !== 'finished').length,
        domNodes: document.getElementsByTagName('*').length,
        heapBefore,
        heapAfter: performance.memory?.usedJSHeapSize ?? null,
      }
    }, stressSwitches)
    console.log(`Repeated frame switches: ${JSON.stringify(stressPerformance)}`)
  }

  const idleDiagnosticMs = Math.max(0, Number(process.env.RMS_UI_IDLE_DIAGNOSTIC_MS) || 0)
  if (idleDiagnosticMs) {
    const idlePerformance = await page.evaluate(async (durationMs) => {
      const frameTimes = []
      const longTasks = []
      const startedAt = performance.now()
      const observer = typeof PerformanceObserver === 'function'
        ? new PerformanceObserver(list => {
            longTasks.push(...list.getEntries().map(entry => ({
              startTime: entry.startTime,
              duration: entry.duration,
            })))
          })
        : null
      try { observer?.observe({ type: 'longtask' }) } catch { /* unsupported */ }
      await new Promise(resolve => {
        const sample = (timestamp) => {
          frameTimes.push(timestamp)
          if (performance.now() - startedAt < durationMs) requestAnimationFrame(sample)
          else resolve()
        }
        requestAnimationFrame(sample)
      })
      observer?.disconnect()
      const intervals = frameTimes.slice(1).map((time, index) => time - frameTimes[index])
      return {
        durationMs: performance.now() - startedAt,
        frameCount: frameTimes.length,
        medianFrameInterval: intervals.slice().sort((left, right) => left - right)[Math.floor(intervals.length / 2)] || null,
        worstFrameInterval: intervals.length ? Math.max(...intervals) : null,
        intervalsOver50ms: intervals.filter(interval => interval > 50),
        longTasks,
        runtimeMetricReads: window.analysisCheck.runtimeMetricReads,
      }
    }, idleDiagnosticMs)
    console.log(`Idle performance: ${JSON.stringify(idlePerformance)}`)
  }

  if (!performanceOnly) {
  // A slow result retains the previous analysis. Loading feedback appears only
  // after the delay and disappears when the complete next result is presented.
  await page.evaluate(async () => {
    const check = window.analysisCheck
    const { vm } = check
    check.originalJumpForSlowAnalysis = window.studioAPI.jumpToNode
    check.originalReadForSlowAnalysis = window.studioAPI.getAnalysis
    check.slowNodeId = `${vm.gameView.currentNodeId}-slow`
    check.slowResult = check.resultForNode(check.slowNodeId, 3)
    window.studioAPI.getAnalysis = () => new Promise(resolve => { check.resolveSlowRead = resolve })
    window.studioAPI.jumpToNode = async () => {
      const view = JSON.parse(JSON.stringify(vm.gameView))
      view.currentNodeId = check.slowNodeId
      view.opponentAnalysis = null
      return { state: JSON.parse(JSON.stringify(vm.status)), view }
    }
    check.oldSlowPiePath = document.querySelector('.analysis-panel-live .shanten-chart path')?.getAttribute('d') || ''
    check.oldSlowRiskCanvas = document.querySelector('.analysis-panel-live .analysis-risk-row-canvas')?.rmsRiskRenderSignature || ''
    await vm.jumpToNode(check.slowNodeId)
  })
  await page.waitForFunction(() => typeof window.analysisCheck.resolveSlowRead === 'function')
  await page.waitForTimeout(350)
  assert.equal(await page.locator('.analysis-loading-overlay').count(), 0, 'short waits do not flash a loading layer')
  assert.equal(
    await page.locator('.analysis-panel-live .shanten-chart path').first().getAttribute('d'),
    await page.evaluate(() => window.analysisCheck.oldSlowPiePath),
    'slow analysis keeps the previous result visible',
  )
  await page.waitForTimeout(200)
  assert.equal(
    await page.locator('.analysis-loading-overlay').count(),
    realisticPerformance ? 4 : 2,
    'each visible analysis panel shows delayed loading feedback',
  )
  if (process.env.RMS_ANALYSIS_LOADING_SCREENSHOT) {
    await page.screenshot({ path: process.env.RMS_ANALYSIS_LOADING_SCREENSHOT })
  }
  await page.evaluate(() => {
    const check = window.analysisCheck
    check.resolveSlowRead(check.slowResult)
  })
  await page.waitForFunction(() => document.querySelectorAll('.analysis-loading-overlay').length === 0)
  await page.waitForFunction(() => (
    document.getAnimations().some(animation => (
      animation.effect?.target instanceof Element
      && Boolean(animation.effect.target.closest('.analysis-panel-live'))
    ))
    || (document.querySelector('.analysis-panel-live .analysis-risk-row-canvas')?.rmsRiskRenderSignature || '')
      !== window.analysisCheck.oldSlowRiskCanvas
  ))
  await page.waitForTimeout(140)
  assert.equal(await page.evaluate(() => document.getAnimations().filter(animation => (
    animation.playState !== 'finished'
    && animation.effect?.target instanceof Element
    && Boolean(animation.effect.target.closest('.analysis-panel-live'))
  )).length), 0, 'slow-result handoff also finishes its value animations')
  await page.evaluate(() => {
    const check = window.analysisCheck
    window.studioAPI.jumpToNode = check.originalJumpForSlowAnalysis
    window.studioAPI.getAnalysis = check.originalReadForSlowAnalysis
  })

  await checkWorkspaceDock(page)
  }
  assert.deepEqual(errors, [])
  console.log(performanceOnly
    ? 'Analysis UI performance scenario passed.'
    : 'Analysis UI: events, hover, navigation motion, cache, geometry, artwork and workspace docking passed.')
} catch (error) {
  if (process.env.GITHUB_ACTIONS) {
    const detail = error instanceof Error ? error.stack || error.message : String(error)
    const annotation = detail
      .replaceAll('%', '%25')
      .replaceAll('\r', '%0D')
      .replaceAll('\n', '%0A')
    console.error(`::error title=Renderer interaction check failed::${annotation}`)
  }
  throw error
} finally {
  await browser?.close()
  await electronApp?.close()
  await server.close()
}
