import assert from 'node:assert/strict'

export async function checkAnalysisLoading(page) {
  await page.evaluate(async () => {
    const check = window.analysisCheck, { vm } = check
    check.loadingFixture = { view: structuredClone(JSON.parse(JSON.stringify(vm.gameView))),
      status: JSON.parse(JSON.stringify(vm.status)), jump: window.studioAPI.jumpToNode, read: window.studioAPI.getAnalysis,
      layout: JSON.parse(JSON.stringify(vm.workspaceLayout)),
      decisionEnabled: document.querySelector('#app').__vue_app__._instance.setupState.decisionRecommendationsEnabled }
    check.pendingReads = []
    document.querySelector('#app').__vue_app__._instance.setupState.decisionRecommendationsEnabled = true
    vm.status.mode = 'research'
    vm.settings.display.workspaceLayout = { ...vm.workspaceLayout, consoleVisible: true }
    vm.status.modelRuntime.decision = { profileId: 'loading-test', unloaded: false, ready: true }
    vm.status.modelRuntime.opponentAnalysis = { profileId: 'loading-test', unloaded: false, ready: true }
    vm.status.modelActivity.decision = ['idle', 'idle', 'idle', 'idle']
    vm.status.modelActivity.opponentAnalysis = 'idle'
    check.decisionResult = value => ({ model: 'loading-test', seat: vm.status.controlledSeat,
      discardEntries: [{ candidateId: 'loading-discard', pai: '1m', value, metrics: { probability: value } }],
      metricDefinitions: [{ id: 'probability', title: 'Probability', format: 'percentage', fractionDigits: 1, preferredDirection: 'higher' }] })
    vm.gameView.legalActions = [{ id: 'loading-discard', type: 'dahai', actor: vm.status.controlledSeat, pai: '1m', tsumogiri: false }]
    vm.gameView.analysis = check.decisionResult(.7)
    vm.stageOpponentAnalysisForView(check.result(), { withoutMotion: true })
    const base = JSON.parse(JSON.stringify(vm.gameView))
    window.studioAPI.getAnalysis = () => new Promise(resolve => check.pendingReads.push(resolve))
    window.studioAPI.jumpToNode = async id => {
      const view = structuredClone(base)
      view.currentNodeId = id
      view.analysis = { model: '', seat: vm.status.controlledSeat, discardEntries: [], context: { dataState: 'reading' } }
      view.opponentAnalysis = { status: 'loading', context: { gameId: view.gameId, nodeId: id,
        seat: vm.status.controlledSeat, dataState: 'reading', cacheEpoch: check.epoch } }
      return { state: JSON.parse(JSON.stringify(vm.status)), view }
    }
  })
  const opponents = page.locator('.analysis-dock .analysis-loading-overlay')
  const evaluation = page.locator('.evaluation-body .analysis-loading-overlay')
  try {
    await page.waitForFunction(() => document.querySelector('.evaluation-body')?.textContent.includes('70.0%')).catch(async error => {
      console.error('Loading fixture state', await page.evaluate(() => ({ mode: window.analysisCheck.vm.status.mode,
        console: document.querySelector('.console-dock')?.textContent?.slice(-350), evaluation: document.querySelector('.evaluation-body')?.textContent,
        layout: window.analysisCheck.vm.workspaceLayout })))
      throw error
    })
    const before = await page.locator('.evaluation-body').innerText()
    await page.evaluate(async () => {
      window.analysisCheck.loadingStarted = performance.now()
      await window.analysisCheck.vm.jumpToNode('loading-1')
    })
    await page.waitForTimeout(280)
    assert.equal(await opponents.count(), 0, 'short opponent waits retain content without an overlay')
    assert.equal(await evaluation.count(), 0, 'short decision waits use the same delay')
    assert.equal(await page.locator('.evaluation-body').innerText(), before, 'decision rows remain complete while the next result is pending')
    await page.evaluate(() => window.analysisCheck.vm.jumpToNode('loading-2'))
    await page.waitForFunction(() => performance.now() - window.analysisCheck.loadingStarted > 550)
    assert.ok(await opponents.count() > 0, 'superseding a pending frame does not restart the opponent delay')
    assert.equal(await evaluation.count(), 1, 'superseding a pending frame does not restart the decision delay')
    await page.evaluate(() => {
      window.analysisCheck.loadingNodes = [...document.querySelectorAll('.analysis-loading-overlay')]
    })
    await page.evaluate(() => window.analysisCheck.vm.jumpToNode('loading-3'))
    assert.equal(await page.evaluate(() => window.analysisCheck.loadingNodes.every(node => node.isConnected)), true,
      'visible loading overlays remain mounted across another pending frame')
    await page.evaluate(() => {
      const check = window.analysisCheck, { vm } = check
      check.pendingReads[0](check.resultForNode('loading-1', 9))
      vm.handlePythonEvent({ type: 'analysis_ready', gameId: vm.gameView.gameId, nodeId: 'loading-1',
        analysis: check.decisionResult(.9), seat: vm.status.controlledSeat })
    })
    await page.waitForTimeout(30)
    assert.equal(await evaluation.count(), 1, 'stale decision completion cannot clear the current loading episode')
    assert.ok(await opponents.count() > 0, 'stale opponent completion cannot clear the current loading episode')
    await page.evaluate(() => {
      const check = window.analysisCheck, { vm } = check
      // Lazy saved facts must be able to finish even if the provider is unloaded.
      vm.status.modelRuntime.decision.unloaded = true
      check.pendingReads.at(-1)(check.resultForNode('loading-3', 3))
      vm.handlePythonEvent({ type: 'analysis_ready', gameId: vm.gameView.gameId, nodeId: 'loading-3',
        analysis: check.decisionResult(.8), seat: vm.status.controlledSeat })
    })
    await page.waitForFunction(() => document.querySelector('.evaluation-body')?.textContent.includes('80.0%'))
    await page.waitForFunction(() => document.querySelectorAll('.analysis-loading-overlay').length === 0)
    await page.evaluate(() => window.analysisCheck.vm.jumpToNode('loading-4'))
    await page.waitForTimeout(300)
    assert.equal(await evaluation.count(), 0, 'a genuinely completed wait permits a fresh delay')
    await page.waitForTimeout(230)
    assert.equal(await evaluation.count(), 1, 'saved decision reads show loading without a provider')
    await page.evaluate(() => {
      const { vm } = window.analysisCheck
      // The actual saved-read failure payload need not contain model/seat data.
      vm.gameView.analysis = { discardEntries: [], reactionEntries: [], error: 'Injected saved-read failure' }
    })
    await page.waitForFunction(() => document.querySelector('.evaluation-body')?.textContent.includes('Injected saved-read failure'))
    assert.equal(await evaluation.count(), 0, 'a failed decision read leaves the loading state')
    await page.evaluate(() => {
      const { vm } = window.analysisCheck
      vm.gameView.gameId = 'loading-new-record'
      vm.gameView.analysis = { model: '', seat: vm.status.controlledSeat, discardEntries: [], context: { dataState: 'reading' } }
    })
    await page.waitForFunction(() => document.querySelector('.evaluation-body')?.textContent.includes('正在加载'))
    assert.equal(await page.locator('.evaluation-body .analysis-row').count(), 0, 'a different record cannot retain the old decision rows')
    await page.evaluate(() => {
      document.querySelector('#app').__vue_app__._instance.setupState.decisionRecommendationsEnabled = false
    })
    await page.waitForFunction(() => !document.querySelector('.evaluation-body')?.textContent.includes('正在加载'))
    await page.evaluate(() => {
      const { vm } = window.analysisCheck
      document.querySelector('#app').__vue_app__._instance.setupState.decisionRecommendationsEnabled = true
      vm.gameView.analysis = window.analysisCheck.decisionResult(.6)
    })
    await page.waitForFunction(() => document.querySelector('.evaluation-body')?.textContent.includes('60.0%'))
    await page.evaluate(() => { const vm = window.analysisCheck.vm; vm.status.controlledSeat = (vm.status.controlledSeat + 1) % 4 })
    await page.waitForFunction(() => document.querySelectorAll('.evaluation-body .analysis-row').length === 0)
    console.log('Analysis loading: continuous/superseded waits, decision retention, stale replies, provider-independent reads, failures and new-record retirement passed.')
  } finally {
    await page.evaluate(() => {
      const check = window.analysisCheck, { vm } = check, original = check.loadingFixture
      const state = document.querySelector('#app').__vue_app__._instance.setupState
      state.invalidateOpponentRead()
      state.decisionRecommendationsEnabled = original.decisionEnabled
      window.studioAPI.jumpToNode = original.jump; window.studioAPI.getAnalysis = original.read
      Object.assign(vm.status, original.status); Object.assign(vm.gameView, original.view)
      vm.settings.display.workspaceLayout = original.layout
      vm.stageOpponentAnalysisForView(original.view.opponentAnalysis, { withoutMotion: true, resetDisplay: true })
      delete check.loadingFixture; delete check.pendingReads; delete check.loadingNodes
    })
  }
}
