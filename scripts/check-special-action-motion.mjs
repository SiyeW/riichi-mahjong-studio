import assert from 'node:assert/strict'

// Exercise the actual App-owned buttons, including opponent reset isolation.
export async function checkSpecialActionMotion(page) {
  const result = await page.evaluate(async () => {
    const { vm } = window.analysisCheck
    const state = document.querySelector('#app').__vue_app__._instance.setupState
    const original = { legal: vm.gameView.legalActions, analysis: vm.gameView.analysis,
      reduced: vm.settings.display.reduceMotion, suppressed: state.suppressAnalysisTransitions }
    const tick = () => new Promise(resolve => requestAnimationFrame(resolve))
    const nextPaint = async () => { await tick(); await tick() }
    const write = (value, suffix = '') => {
      vm.gameView.legalActions = [
        { id: 'motion-pon', candidateId: 'pon' + suffix, type: 'pon', variant: 'pon', actor: 0, target: 1, pai: '5m', consumed: ['5m', '5mr'] },
        { id: 'motion-skip', candidateId: 'skip' + suffix, type: 'none', variant: 'none', actor: 0 },
      ]
      vm.gameView.analysis = { model: 'motion-fixture', seat: 0, reactionEntries: [
        { candidateId: 'pon' + suffix, type: 'pon', variant: 'pon', value, bar: value },
        { candidateId: 'skip' + suffix, type: 'none', variant: 'none', value: 1 - value, bar: 1 },
      ] }
    }
    const read = fill => new DOMMatrix(getComputedStyle(fill).transform).m22
    const sample = fill => {
      const transition = fill.getAnimations().find(a => a.transitionProperty === 'transform')
      if (!transition) throw Error('Special-action bar did not start an actual transform transition')
      transition.pause()
      const timing = transition.effect.getTiming()
      const values = [0, 20, 55, 110].map(time => { transition.currentTime = time; return read(fill) })
      transition.finish()
      return { values, duration: timing.duration, easing: timing.easing }
    }
    try {
      vm.settings.display.reduceMotion = false
      vm.gameView.legalActions = []
      await nextPaint()
      write(.8)
      await nextPaint()
      const fill = document.querySelector('.special-action-bar-fill')
      const entering = sample(fill)
      await nextPaint()
      const track = fill.parentElement.getBoundingClientRect()
      // This reset belongs to opponent presentation, not action recommendation.
      state.suppressAnalysisTransitions = true
      write(.2, '-new-result')
      await nextPaint()
      if (fill !== document.querySelector('.special-action-bar-fill')) throw Error('Stable action button was remounted')
      const updating = sample(fill)
      const after = fill.parentElement.getBoundingClientRect()
      vm.settings.display.reduceMotion = true
      await nextPaint()
      write(.65)
      await nextPaint()
      return { entering, updating, trackStable: track.height === after.height && track.bottom === after.bottom,
        reduced: read(fill), reducedAnimations: fill.getAnimations().length }
    } finally {
      vm.settings.display.reduceMotion = original.reduced
      state.suppressAnalysisTransitions = original.suppressed
      vm.gameView.legalActions = original.legal
      vm.gameView.analysis = original.analysis
    }
  })
  for (const phase of [result.entering, result.updating]) {
    assert.equal(phase.duration, 110)
    assert.equal(phase.easing, 'cubic-bezier(0.33, 1, 0.68, 1)')
    assert.ok(Math.abs(phase.values[1] - phase.values[0]) > .1, JSON.stringify(phase))
    assert.ok(Math.abs(phase.values[1] - phase.values[0]) > Math.abs(phase.values[3] - phase.values[2]), 'ease-out is front-loaded')
  }
  assert.ok(Math.abs(result.entering.values[0]) < .001)
  assert.ok(Math.abs(result.entering.values[3] - .8) < .001)
  assert.ok(Math.abs(result.updating.values[0] - .8) < .001)
  assert.ok(Math.abs(result.updating.values[3] - .2) < .001)
  assert.equal(result.trackStable, true)
  assert.ok(Math.abs(result.reduced - .65) < .001)
  assert.equal(result.reducedAnimations, 0)
  console.log(`Special-action motion: ${JSON.stringify(result)}`)
}
