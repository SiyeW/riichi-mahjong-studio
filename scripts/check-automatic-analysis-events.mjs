import assert from 'node:assert/strict'

export async function checkAutomaticAnalysisEvents(page) {
  const original = await page.evaluate(() => {
    const vm = window.analysisCheck.vm
    return { progress: JSON.parse(JSON.stringify(vm.status.autoAnalysis)), node: vm.gameView.currentNodeId }
  })
  const publish = async (timeline, state) => {
    await page.evaluate(({ timeline, state }) => {
      const vm = window.analysisCheck.vm
      const ready = [...timeline].filter(char => char === 'M' || char === 'O').length
      vm.handlePythonEvent({ type: 'auto_analysis_progress', gameId: vm.gameView.gameId,
        nodeId: 'different-round-background-node', autoAnalysis: {
          ...vm.status.autoAnalysis, status: state, currentNodeId: state === 'running' ? 'different-round-background-node' : null,
          currentModel: state === 'running' ? 'opponent' : null,
          timeline, timelineReady: ready, total: timeline.length, completed: ready, failed: 0,
        } })
    }, { timeline, state })
    await page.waitForFunction(timeline => document.querySelector('.auto-analysis-progress canvas')?.rmsAutomaticAnalysisTimeline === timeline, timeline)
    return page.locator('.auto-analysis-progress canvas').evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, Math.floor(canvas.height / 2), canvas.width, 1).data
      return { alpha: Array.from({ length: canvas.width }, (_, x) => pixels[x * 4 + 3]),
        width: canvas.width, expectedWidth: Math.round(canvas.getBoundingClientRect().width * devicePixelRatio) }
    })
  }
  try {
    const partial = await publish('o'.repeat(292) + 'O'.repeat(242), 'running')
    assert.equal(partial.alpha[0], 0)
    assert.equal(partial.alpha.at(-1), 255)
    assert.equal(await page.locator('.auto-analysis-progress small').innerText(), '242 / 534')
    const complete = await publish('O'.repeat(534), 'completed')
    assert.ok(complete.alpha.every(value => value === 255), 'other-round completion paints the whole bar without analysis-ready/view events')
    assert.equal(complete.width, complete.expectedWidth, 'stop/start label width change cannot leave the canvas at its old dimensions')
    assert.equal(await page.locator('.auto-analysis-progress small').innerText(), '534 / 534')
    assert.equal(await page.evaluate(() => window.analysisCheck.vm.gameView.currentNodeId), original.node)
    const stopped = await publish('M'.repeat(242) + 'o'.repeat(292), 'canceled')
    assert.equal(stopped.alpha[0], 255)
    assert.equal(stopped.alpha.at(-1), 0, 'cancellation retains only the actual ready positions')
    console.log('Automatic progress events: non-current-round work, completion, cancellation and unchanged browsing position passed.')
  } finally {
    await page.evaluate(progress => { window.analysisCheck.vm.status.autoAnalysis = progress }, original.progress)
    await page.waitForTimeout(40)
  }
}
