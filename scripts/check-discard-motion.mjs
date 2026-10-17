import assert from 'node:assert/strict'
import { checkFlightOcclusion } from './check-flight-occlusion.mjs'

export async function checkDiscardMotion(page) {
  await checkTableZoomOwnership(page)
  await checkWheelProgress(page)
  await checkFlightOcclusion(page)
  // The ordinary pixel/occlusion suite above remains the default sharp path.
  // This opt-in runs the real navigation owner below with coverage enabled.
  const coverageTrial = Boolean(process.env.RMS_UI_COVERAGE_TRIAL)
  if (coverageTrial) {
    await page.evaluate(() => {
      const state = document.querySelector('#app').__vue_app__._instance.setupState
      // The preceding pixel fixture cancels paused Animation objects directly.
      // Retire their owner too before sampling an actual idle cadence.
      state.cancelPendingDiscardFlight(); state.cancelPendingDiscardReturnFlight()
      state.coverageTrialEnabled = true
    })
    await page.locator('.discard-motion-surface[data-ready="true"]').waitFor({ state: 'attached' })
  }
  await page.evaluate(async () => {
    const motion = await import('/src/uiMotion.ts')
    const old = document.body.style.getPropertyValue('--ui-motion-duration')
    const originalStyle = window.getComputedStyle
    let reads = 0
    window.getComputedStyle = (...args) => { if (args[0] === document.body) reads++; return originalStyle(...args) }
    try {
      for (let i = 0; i < 50; i++) { motion.getUiMotionDurationMs(); motion.getUiMotionEasing() }
      if (reads > 1) throw new Error('Motion constants repeatedly force style calculation')
      document.body.style.setProperty('--ui-motion-duration', '90ms')
      await Promise.resolve()
      if (motion.getUiMotionDurationMs() !== 90) throw new Error('Changed shared motion tokens were not refreshed')
    } finally {
      window.getComputedStyle = originalStyle
      if (old) document.body.style.setProperty('--ui-motion-duration', old)
      else document.body.style.removeProperty('--ui-motion-duration')
      await Promise.resolve()
    }
  })
  const cases = await page.evaluate(async coverageTrial => {
    const { vm } = window.analysisCheck
    const original = JSON.parse(JSON.stringify(vm.gameView))
    const originalJump = window.studioAPI.jumpToNode
    const visibleHands = vm.status.visibleHands
    vm.status.visibleHands = false
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
    const waitWarm = async () => {
      if (!coverageTrial) return
      const limit = performance.now() + 4000
      while (!document.querySelector('.discard-motion-surface[data-ready="true"]')) {
        if (performance.now() > limit) throw Error('Coverage warmup did not finish')
        await new Promise(resolve => setTimeout(resolve, 1))
      }
    }
    const readyCoverage = async () => {
      if (!coverageTrial) return
      const limit = performance.now() + 400
      while (!document.querySelector('.discard-flight-coverage')) {
        if (performance.now() > limit) throw Error('Opt-in flight did not finish preparation: ' + JSON.stringify(document.querySelector('.discard-motion-surface')?.dataset))
        await new Promise(resolve => setTimeout(resolve, 1))
      }
    }
    const cases = []
    let lifecycleFixture
    try {
      for (const riichi of [false, true]) for (let offset = 1; offset <= 3; offset++) {
        const actor = (vm.status.controlledSeat + offset) % 4
        const parent = JSON.parse(JSON.stringify(original))
        parent.currentNodeId = `motion-parent-${actor}`
        parent.table.pendingDiscard = null
        parent.table.pendingRiichiDiscard = null
        parent.table.hands[actor] = ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p', '5p']
        parent.table.rivers[actor] = []
        parent.table.actionHistory = [{ type: 'tsumo', actor, pai: '5p' }]
        const childId = `motion-discard-${actor}`
        parent.tree = { rootNodeId: parent.currentNodeId, currentNodeId: parent.currentNodeId,
          mainLeafNodeId: childId, currentRoundRootId: parent.currentNodeId, revision: 1,
          nodes: [
            { id: parent.currentNodeId, parentId: null, children: [childId], depth: 0 },
            { id: childId, parentId: parent.currentNodeId, children: [], depth: 1 },
          ], rounds: [] }
        vm.gameView.table = parent.table
        vm.gameView.currentNodeId = parent.currentNodeId
        vm.gameView.tree = parent.tree
        await frame()
        const child = structuredClone(parent)
        child.currentNodeId = childId
        child.table.hands[actor].pop()
        child.table.pendingDiscard = { actor, pai: '5p', tsumogiri: true, targetActor: actor, riichi }
        child.table.actionHistory.push({ type: 'dahai', actor, pai: '5p', tsumogiri: true })
        lifecycleFixture = { parent, child, actor }
        window.studioAPI.jumpToNode = async id => ({ state: JSON.parse(JSON.stringify(vm.status)), view: id === childId ? child : parent })
        await vm.jumpToNode(child.currentNodeId)
        await frame()
        await frame()
        await readyCoverage()
        const tile = document.querySelector(`[data-pending-discard-seat="${actor}"]`)
        const back = tile?.querySelector(riichi ? '.discard-flight-regular-pose' : '.discard-flight-back')
        const face = tile?.querySelector('.tileImg:not(.discard-flight-back)')
        const movement = tile?.getAnimations().find(animation => animation.effect.getKeyframes().some(key => key.transform))
        const fade = back?.getAnimations()[0]
        const a = face?.getBoundingClientRect(), b = (riichi ? back?.querySelector('.tileImg') : back)?.getBoundingClientRect()
        const sameCenter = a && b ? Math.max(Math.abs(a.x + a.width / 2 - b.x - b.width / 2),
          Math.abs(a.y + a.height / 2 - b.y - b.height / 2)) : null
        const item = { actor, riichi, movement: movement?.playState, fade: fade?.playState,
          movementTime: movement?.currentTime, fadeTime: fade?.currentTime,
          displacement: sameCenter }
        if (coverageTrial) {
          const root = document.querySelector('.discard-flight-coverage')
          if (!root) throw Error('Opt-in navigation did not create its flight coverage')
          const native = [movement, fade].filter(Boolean)
          item.coverageSurfaces = document.querySelectorAll('.discard-flight-coverage').length
          const starts = [Number(root.dataset.startTime), ...native.map(a => a.startTime)]
          item.timelineSpread = Math.max(...starts) - Math.min(...starts)
          if (root.querySelector('[data-pending-discard-seat], [data-hand-seat], .tileImg, .history-jump-target')) {
            throw Error('Visual coverage clones leaked interactive selectors')
          }
        }
        // Reverse and supersede the animation before it finishes, as a quick
        // wheel reversal does. Old callbacks must not cancel the new flight.
        await vm.jumpToNode(parent.currentNodeId)
        await frame()
        if (coverageTrial) {
          await frame()
          await readyCoverage()
          if (!document.querySelector('.discard-flight-coverage')) throw Error('Reverse flight lost coverage')
        }
        await vm.jumpToNode(childId)
        await frame()
        await frame()
        item.replacementActive = Boolean(document.querySelector(`[data-pending-discard-seat="${actor}"]`)
          ?.getAnimations().some(animation => animation.playState === 'running'
            || (coverageTrial && animation.playState === 'paused' && animation.currentTime === 0)))
        if (!riichi) {
          const repeated = structuredClone(child)
          repeated.currentNodeId = `${childId}-same-face`
          repeated.table.rivers[actor].push('1m')
          window.studioAPI.jumpToNode = async () => ({ state: JSON.parse(JSON.stringify(vm.status)), view: repeated })
          await vm.jumpToNode(repeated.currentNodeId)
          await frame()
          await frame()
          item.repeatedFaceActive = Boolean(document.querySelector(`[data-pending-discard-seat="${actor}"]`)
            ?.getAnimations().some(animation => animation.playState === 'running'
              || (coverageTrial && animation.playState === 'paused' && animation.currentTime === 0)))
        }
        await new Promise(resolve => setTimeout(resolve, 220))
        item.remainingOverlays = document.querySelectorAll('.discard-flight-back, .discard-flight-regular-pose, .discard-return-ghost').length
        item.remainingCoverage = document.querySelectorAll('.discard-flight-coverage').length
        item.remainingOpacity = document.querySelector(`[data-pending-discard-seat="${actor}"]`)?.style.opacity || ''
        item.remainingFaceEffects = [...document.querySelectorAll('.grid-discard .tileImg')]
          .flatMap(image => image.getAnimations()).filter(animation => animation.effect.getKeyframes().some(key => key.opacity !== undefined)).length
        cases.push(item)
      }
      const state = document.querySelector('#app').__vue_app__._instance.setupState
      const { parent, child, actor } = lifecycleFixture
      const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
      const zoom = state.tableZoom, reduced = vm.settings.display.reduceMotion
      const shell=document.querySelector('.shell')
      let hidden = false
      const start = async () => {
        window.studioAPI.jumpToNode = async id => ({ state: JSON.parse(JSON.stringify(vm.status)), view: id === child.currentNodeId ? child : parent })
        await waitWarm()
        await vm.jumpToNode(parent.currentNodeId); await frame()
        await vm.jumpToNode(child.currentNodeId); await frame(); await frame(); await readyCoverage()
        if (!state.tableMotionActive) throw Error('Lifecycle fixture did not admit a motion owner')
      }
      const retired = label => {
        if (state.tableMotionActive || state.hasPendingDiscardFlight()
          || document.querySelector('.discard-return-ghost,.discard-flight-back,.discard-flight-regular-pose,.discard-flight-coverage')
          || [...document.querySelectorAll('[data-hand-seat]')].some(node => node.style.visibility === 'hidden')) {
          throw Error(`${label} left a motion owner, ghost, overlay or hidden destination: `+JSON.stringify({
            active:state.tableMotionActive,pending:state.hasPendingDiscardFlight(),zoom:state.tableZoom,
            transient:[...document.querySelectorAll('.discard-return-ghost,.discard-flight-back,.discard-flight-regular-pose,.discard-flight-coverage')].map(node=>({class:node.className,data:{...node.dataset}})),
            hidden:[...document.querySelectorAll('[data-hand-seat]')].filter(node=>node.style.visibility==='hidden').map(node=>({...node.dataset})),
          }))
        }
      }
      try {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
        await start()
        hidden = true; document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve()
        retired('Hidden document')
        await vm.jumpToNode(parent.currentNodeId); await frame()
        await vm.jumpToNode(child.currentNodeId); await frame(); await frame()
        retired('Hidden admission')
        hidden = false; document.dispatchEvent(new Event('visibilitychange'))
        await start(); window.dispatchEvent(new Event('resize')); retired('Window resize')
        await start()
        const source=document.querySelector(`[data-pending-discard-seat="${actor}"]`),before=source.getBoundingClientRect().width
        // Test the geometry observer through its real CSS owner. The preceding
        // window-resize fit passes can overwrite a synthetic tableZoom assignment
        // before layout/ResizeObserver delivery; that did not resize the scene.
        // Reactive tableZoom -> CSS is tested independently above.
        shell.style.setProperty('--zoom',String(zoom*.9))
        await frame(); await frame()
        if(Math.abs(source.getBoundingClientRect().width-before)<1)throw Error('Forward resize fixture did not retain changed geometry')
        retired('Forward geometry change')
        shell.style.setProperty('--zoom',String(zoom)); await frame(); await frame()
        await start(); await new Promise(resolve => setTimeout(resolve, 240))
        await vm.jumpToNode(parent.currentNodeId); await frame(); await frame(); await readyCoverage()
        if (!document.querySelector('.discard-return-ghost')) throw Error('Reverse geometry fixture did not own its ghost')
        const hand=document.querySelector('[data-hand-seat]'),handWidth=hand.getBoundingClientRect().width
        shell.style.setProperty('--zoom',String(zoom*.9))
        await frame(); await frame(); retired('Reverse destination resize')
        if(Math.abs(hand.getBoundingClientRect().width-handWidth)<1)throw Error('Reverse resize fixture did not retain changed geometry')
        shell.style.setProperty('--zoom',String(zoom)); await frame(); await frame()
        await start(); vm.settings.display.reduceMotion = true
        await frame(); retired('Reduced motion')
      } finally {
        if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden)
        else delete document.hidden
        state.tableZoom = zoom; shell.style.setProperty('--zoom',String(zoom)); vm.settings.display.reduceMotion = reduced
        document.dispatchEvent(new Event('visibilitychange'))
        state.cancelPendingDiscardFlight(); state.cancelPendingDiscardReturnFlight()
      }
      cases[0].lifecycleRetirement = true
    } finally {
      window.studioAPI.jumpToNode = originalJump
      vm.status.visibleHands = visibleHands
      vm.gameView.table = original.table
      vm.gameView.currentNodeId = original.currentNodeId
      vm.gameView.tree = original.tree
      document.querySelector('#app').__vue_app__._instance.setupState.coverageTrialEnabled = false
    }
    return cases
  }, coverageTrial)
  console.log(`Discard motion phases: ${JSON.stringify(cases)}`)
  assert.equal(cases[0].lifecycleRetirement, true, 'hidden, reduced and resized motion retires cleanly without blocking autoplay')
  for (const item of cases) {
    assert.ok(item.movement && item.fade, `both motion layers are active: ${JSON.stringify(item)}`)
    assert.ok(item.displacement !== null && item.displacement < .1, `face/back alignment: ${JSON.stringify(item)}`)
    assert.equal(item.movement, item.fade, `face and movement share the same playback phase: ${JSON.stringify(item)}`)
    assert.ok(Math.abs(item.movementTime - item.fadeTime) < 1, 'face and movement use one timeline')
    assert.equal(item.replacementActive, true, 'a cancelled predecessor cannot clear the replacement animation')
    if (!item.riichi) assert.equal(item.repeatedFaceActive, true, 'another discard of the same face is a distinct moving tile')
    assert.equal(item.remainingOverlays, 0, 'all transient flight layers are retired')
    assert.equal(item.remainingFaceEffects, 0, 'pose swaps cannot leave an opacity effect on a reused river tile')
    assert.equal(item.remainingCoverage, 0, 'coverage surfaces retire after finishing/replacement')
    assert.equal(item.remainingOpacity, '', 'coverage restores source opacity')
    if (coverageTrial) {
      assert.equal(item.coverageSurfaces, 1, 'one bounded local surface replaces the sample tree')
      assert.equal(item.timelineSpread, 0, 'source, face, pose and coverage use one native timeline')
    }
  }
}

async function checkTableZoomOwnership(page) {
  const result = await page.evaluate(async () => {
    const instance = document.querySelector('#app').__vue_app__._instance
    const state = instance.setupState
    const originalHooks = instance.u, originalZoom = state.tableZoom
    const shell = document.querySelector('.shell')
    const image = document.querySelector('.grid-main .tileImg')
    const initialWidth = image.getBoundingClientRect().width
    let rootUpdates = 0
    instance.u = [...(originalHooks || []), () => rootUpdates++]
    try {
      const requested = originalZoom * .85
      state.tableZoom = requested
      await Promise.resolve(); await Promise.resolve()
      return { requested, applied: Number(shell.style.getPropertyValue('--zoom')),
        initialWidth, nextWidth: image.getBoundingClientRect().width, rootUpdates }
    } finally {
      state.tableZoom = originalZoom
      await Promise.resolve(); await Promise.resolve()
      instance.u = originalHooks
    }
  })
  assert.equal(result.applied, result.requested, 'table geometry reaches its CSS owner')
  assert.ok(result.nextWidth < result.initialWidth - 1, 'real tile dimensions change')
  assert.equal(result.rootUpdates, 0, 'table-only geometry must not rerender the application root')
}

async function checkWheelProgress(page) {
  await page.evaluate(async () => {
    const { vm } = window.analysisCheck
    const original = JSON.parse(JSON.stringify(vm.gameView))
    const originalJump = window.studioAPI.jumpToNode
    const base = structuredClone(original)
    base.viewToken = { sessionId: 'wheel-fixture', sequence: 0, intent: 0, gameId: base.gameId,
      nodeId: 'wheel-0', seat: vm.status.controlledSeat, mode: vm.status.mode, visibleHands: false,
      decisionEpoch: 0, opponentEpoch: 0 }
    base.tree = { rootNodeId: 'wheel-0', currentNodeId: 'wheel-0', mainLeafNodeId: 'wheel-3',
      currentRoundRootId: 'wheel-0', revision: 1, rounds: [], nodes: Array.from({ length: 4 }, (_, i) => ({
        id: `wheel-${i}`, parentId: i ? `wheel-${i-1}` : null, children: i < 3 ? [`wheel-${i+1}`] : [],
        mainChildId: i < 3 ? `wheel-${i+1}` : null, depth: i,
      })) }
    const requests = []
    let delayed = false
    window.studioAPI.jumpToNode = id => {
      const response = { state: JSON.parse(JSON.stringify(vm.status)), view: { ...base, currentNodeId: id,
        viewToken: { ...base.viewToken, nodeId: id } } }
      if (!delayed) return Promise.resolve(response)
      return new Promise(resolve => requests.push(() => resolve(response)))
    }
    const settle = () => new Promise(resolve => setTimeout(resolve, 0))
    const wheel = direction => document.querySelector('.grid-main').dispatchEvent(
      new WheelEvent('wheel', { deltaY: direction * 100, bubbles: true, cancelable: true }))
    try {
      // Bind this synthetic cursor's identity without simulating a record open;
      // the fixture must not reset unrelated analysis/cache/display preferences.
      vm.gameView.viewToken = base.viewToken
      await vm.jumpToNode('wheel-0')
      await settle()
      delayed = true
      wheel(1)
      wheel(1)
      requests.shift()()
      await settle()
      if (vm.gameView.currentNodeId !== 'wheel-1') throw new Error('Continuous wheel input starved completed table updates')
      requests.shift()()
      await settle()
      if (vm.gameView.currentNodeId !== 'wheel-2') throw new Error('The queued wheel target was lost')
      wheel(-1)
      wheel(1)
      requests.shift()()
      await settle()
      if (vm.gameView.currentNodeId !== 'wheel-2') throw new Error('A reply from before wheel reversal moved the table backwards')
      requests.shift()()
      await settle()
      delayed = false
      await vm.jumpToNode('wheel-0'); await settle()
      wheel(3); await settle()
      if (vm.gameView.currentNodeId !== 'wheel-3') throw new Error('A coalesced wheel event lost its extra steps')
      wheel(-3); await settle()
      if (vm.gameView.currentNodeId !== 'wheel-0') throw new Error('Merged forward/backward wheel movement did not conserve the cursor')
      for (let i = 0; i < 4; i++) wheel(.25)
      await settle()
      if (vm.gameView.currentNodeId !== 'wheel-1') throw new Error('Fractional wheel input did not accumulate to one step')
      await vm.jumpToNode('wheel-0'); await settle()
      wheel(1.5); await settle()
      wheel(.5); await settle()
      if (vm.gameView.currentNodeId !== 'wheel-2') throw new Error('An ordinary frame commit reset fractional wheel movement')
      await vm.jumpToNode('wheel-0'); await settle()
      wheel(.5); await settle()
      await vm.jumpToNode('wheel-0'); await settle()
      wheel(.5); await settle()
      if (vm.gameView.currentNodeId !== 'wheel-0') throw new Error('An explicit jump retained an old fractional wheel gesture')
      // Only the active round's nodes are present. Queue steps at an unloaded
      // round, then use its reply as structural facts even after a reversal.
      const rounds = [
        { id: 'round-a', parentRoundId: null, childRoundIds: ['round-b'], mainNextRoundId: 'round-b', depth: 0, roundIndex: 0 },
        { id: 'round-b', parentRoundId: 'round-a', childRoundIds: [], mainNextRoundId: null, depth: 1, roundIndex: 1 },
      ]
      const aNodes = [
        { id: 'round-a', parentId: null, children: ['a-end'], mainChildId: 'a-end', depth: 0 },
        { id: 'a-end', parentId: 'round-a', children: ['round-b'], mainChildId: 'round-b', depth: 1 },
      ]
      const bNodes = [
        { id: 'round-b', parentId: 'a-end', children: ['b-one'], mainChildId: 'b-one', depth: 2 },
        { id: 'b-one', parentId: 'round-b', children: ['b-two'], mainChildId: 'b-two', depth: 3 },
        { id: 'b-two', parentId: 'b-one', children: [], mainChildId: null, depth: 4 },
      ]
      requests.length = 0
      delayed = false
      window.studioAPI.jumpToNode = id => {
        const b = id.startsWith('b-') || id === 'round-b'
        const response = { state: JSON.parse(JSON.stringify(vm.status)), view: { ...original, currentNodeId: id,
          viewToken: { ...base.viewToken, nodeId: id },
          tree: { ...base.tree, currentNodeId: id, currentRoundRootId: b ? 'round-b' : 'round-a',
            rootNodeId: b ? 'round-b' : 'round-a', rounds, nodes: b ? bNodes : aNodes } } }
        return delayed ? new Promise((resolve, reject) => requests.push(Object.assign(() => resolve(response), { reject }))) : Promise.resolve(response)
      }
      await vm.jumpToNode('round-a'); await settle(); delayed = true
      for (let step = 0; step < 4; step++) wheel(1)
      for (let reply = 0; reply < 3; reply++) { if (!requests.length) break; requests.shift()(); await settle() }
      if (vm.gameView.currentNodeId !== 'b-two') throw new Error('Wheel steps were dropped while the next round loaded')
      delayed = false; await vm.jumpToNode('a-end'); await settle(); delayed = true
      wheel(1); wheel(1); wheel(-1)
      requests.shift()(); await settle()
      if (vm.gameView.currentNodeId !== 'a-end') throw new Error('An old cross-round reply displayed after reversal')
      requests.shift()(); await settle()
      if (vm.gameView.currentNodeId !== 'round-b') throw new Error('Deferred cross-round reversal lost its ordered steps')
      delayed = false; await vm.jumpToNode('a-end'); await settle(); delayed = true
      wheel(1); wheel(1)
      requests.shift().reject(new Error('Expected navigation read failure'))
      await settle()
      wheel(-1)
      if (!requests.length) throw new Error('A failed round read left the wheel cursor stranded outside the visible tree')
      requests.shift()(); await settle()
      if (vm.gameView.currentNodeId !== 'round-a') throw new Error('Wheel navigation did not recover after a failed round read')
      delayed = false; await vm.jumpToNode('a-end'); await settle(); delayed = true
      wheel(-1)
      const retiredRequest = requests.shift()
      delayed = false; await vm.jumpToNode('a-end'); await settle(); delayed = true
      wheel(1); wheel(1)
      retiredRequest.reject(new Error('Expected retired navigation failure'))
      await settle()
      for (let reply = 0; reply < 2; reply++) { if (!requests.length) break; requests.shift()(); await settle() }
      if (vm.gameView.currentNodeId !== 'b-one') throw new Error('A retired request failure discarded a newer wheel burst')
    } finally {
      window.studioAPI.jumpToNode = async () => ({ state: JSON.parse(JSON.stringify(vm.status)), view: original })
      vm.gameView.viewToken = original.viewToken
      await vm.jumpToNode(original.currentNodeId)
      window.studioAPI.jumpToNode = originalJump
    }
  })
}
