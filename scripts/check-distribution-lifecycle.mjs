import assert from 'node:assert/strict'

export async function checkDistributionLifecycle(page) {
  const result = await page.evaluate(async () => {
    const { nextTick } = await import('/node_modules/.vite/deps/vue.js')
    const check = window.analysisCheck, vm = check.vm
    const state = document.querySelector('#app').__vue_app__._instance.setupState
    const original = JSON.parse(JSON.stringify({ view: vm.gameView, layout: vm.workspaceLayout,
      displayed: state.displayedOpponentAnalysis, runtime: vm.status.modelRuntime.opponentAnalysis }))
    const read = window.studioAPI.getAnalysis
    let payload
    const settle = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 170)) }
    function stage(nodeId, result) {
      vm.gameView.currentNodeId = nodeId
      payload = result || check.resultForNode(nodeId)
      vm.stageOpponentAnalysisForView(payload, { withoutMotion: true })
    }
    try {
      Object.assign(vm.status.modelRuntime.opponentAnalysis, { unloaded: true, ready: false })
      vm.settings.display.workspaceLayout = { ...original.layout, analysisVisible: true,
        analysisPanels: { opponents: true, game: false, risk: false, counts: false },
        layout: { type: 'split', direction: 'horizontal', weights: [2, 1], children: [
          { type: 'item', id: 'table' }, { type: 'item', id: 'analysis-opponents' },
        ] } }
      window.studioAPI.getAnalysis = async () => payload
      stage('distribution-ready'); await settle()
      const charts = [...document.querySelectorAll('.analysis-distribution-chart')]
      const canvases = charts.map(chart => chart.querySelector('canvas'))
      if (charts.length !== 6 || canvases.some(canvas => !canvas)) throw Error('Expected all six populated opponent charts')
      const signature = canvases[0].rmsDistributionRenderSignature
      charts[0].querySelector('.analysis-distribution-cell').dispatchEvent(new MouseEvent('mouseenter'))
      await settle()
      if (!document.querySelector('.analysis-floating-tooltip')) throw Error('Fixture did not exercise an open tooltip')
      stage('distribution-missing', { status: 'unavailable', outputs: {}, context: {
        gameId: vm.gameView.gameId, nodeId: 'distribution-missing', seat: vm.status.controlledSeat, cacheEpoch: check.epoch,
      } })
      await settle()
      if (document.querySelector('.analysis-floating-tooltip')) throw Error('A tooltip survived the unavailable frame')
      if (state.displayedOpponentAnalysis !== null || Object.keys(state.ronWaitPredData).length
        || state.analysisOpponents.some(opponent => opponent.probabilities.length)) throw Error('Unavailable data remained current')
      if (charts.some((chart, index) => !chart.isConnected || chart.querySelector('canvas') !== canvases[index]
        || getComputedStyle(chart).display !== 'none' || chart.querySelector('.analysis-distribution-cell'))) throw Error('Unavailable chart was destroyed or kept visible data')
      const ready = check.resultForNode('distribution-ready-again')
      for (const player of ready.outputs['opponent-dora-count'].players) {
        const distribution = player.prediction.distribution
        ;[distribution[0].probability, distribution[1].probability] = [distribution[1].probability, distribution[0].probability]
      }
      stage('distribution-ready-again', ready); await settle()
      if (charts.some((chart, index) => chart.querySelector('canvas') !== canvases[index]
        || getComputedStyle(chart).display === 'none')) throw Error('Ready charts did not reuse their original canvas')
      if (canvases[0].rmsDistributionRenderSignature === signature) throw Error('Revealed chart did not repaint new data')
      state.clearOpponentAnalysisWithoutMotion(); await settle()
      if (charts.some(chart => getComputedStyle(chart).display !== 'none'
        || chart.querySelector('.analysis-distribution-cell'))) throw Error('Explicit clear left visible chart data')
      return { charts: charts.length, reusedCanvas: true, unavailableHidden: true, tooltipRetired: true, currentDataCleared: true }
    } finally {
      Object.assign(vm.gameView, original.view)
      Object.assign(vm.status.modelRuntime.opponentAnalysis, original.runtime)
      vm.settings.display.workspaceLayout = original.layout
      window.studioAPI.getAnalysis = read
      state.clearOpponentAnalysisWithoutMotion()
      if (original.displayed) vm.stageOpponentAnalysisForView(original.displayed, { withoutMotion: true })
      await settle()
    }
  })
  assert.equal(result.charts, 6)
  console.log(`Distribution lifecycle: ${JSON.stringify(result)}`)
}
