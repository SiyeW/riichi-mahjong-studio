import assert from 'node:assert/strict'

export async function checkDiscardMotion(page) {
  await checkWheelProgress(page)
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
  const cases = await page.evaluate(async () => {
    const { vm } = window.analysisCheck
    const original = JSON.parse(JSON.stringify(vm.gameView))
    const originalJump = window.studioAPI.jumpToNode
    const visibleHands = vm.status.visibleHands
    vm.status.visibleHands = false
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
    const cases = []
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
        window.studioAPI.jumpToNode = async id => ({ state: JSON.parse(JSON.stringify(vm.status)), view: id === childId ? child : parent })
        await vm.jumpToNode(child.currentNodeId)
        await frame()
        await frame()
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
        // Reverse and supersede the animation before it finishes, as a quick
        // wheel reversal does. Old callbacks must not cancel the new flight.
        await vm.jumpToNode(parent.currentNodeId)
        await frame()
        await vm.jumpToNode(childId)
        await frame()
        await frame()
        item.replacementActive = Boolean(document.querySelector(`[data-pending-discard-seat="${actor}"]`)
          ?.getAnimations().some(animation => animation.playState === 'running'))
        await new Promise(resolve => setTimeout(resolve, 220))
        item.remainingOverlays = document.querySelectorAll('.discard-flight-back, .discard-flight-regular-pose, .discard-return-ghost').length
        item.remainingFaceEffects = [...document.querySelectorAll('.grid-discard .tileImg')]
          .flatMap(image => image.getAnimations()).filter(animation => animation.effect.getKeyframes().some(key => key.opacity !== undefined)).length
        cases.push(item)
      }
    } finally {
      window.studioAPI.jumpToNode = originalJump
      vm.status.visibleHands = visibleHands
      vm.gameView.table = original.table
      vm.gameView.currentNodeId = original.currentNodeId
      vm.gameView.tree = original.tree
    }
    return cases
  })
  console.log(`Discard motion phases: ${JSON.stringify(cases)}`)
  for (const item of cases) {
    assert.ok(item.movement && item.fade, `both motion layers are active: ${JSON.stringify(item)}`)
    assert.ok(item.displacement !== null && item.displacement < .1, `face/back alignment: ${JSON.stringify(item)}`)
    assert.equal(item.movement, item.fade, `face and movement share the same playback phase: ${JSON.stringify(item)}`)
    assert.ok(Math.abs(item.movementTime - item.fadeTime) < 1, 'face and movement use one timeline')
    assert.equal(item.replacementActive, true, 'a cancelled predecessor cannot clear the replacement animation')
    assert.equal(item.remainingOverlays, 0, 'all transient flight layers are retired')
    assert.equal(item.remainingFaceEffects, 0, 'pose swaps cannot leave an opacity effect on a reused river tile')
  }
}

async function checkWheelProgress(page) {
  await page.evaluate(async () => {
    const { vm } = window.analysisCheck
    const original = JSON.parse(JSON.stringify(vm.gameView))
    const originalJump = window.studioAPI.jumpToNode
    const base = structuredClone(original)
    base.tree = { rootNodeId: 'wheel-0', currentNodeId: 'wheel-0', mainLeafNodeId: 'wheel-3',
      currentRoundRootId: 'wheel-0', revision: 1, rounds: [], nodes: Array.from({ length: 4 }, (_, i) => ({
        id: `wheel-${i}`, parentId: i ? `wheel-${i-1}` : null, children: i < 3 ? [`wheel-${i+1}`] : [],
        mainChildId: i < 3 ? `wheel-${i+1}` : null, depth: i,
      })) }
    const requests = []
    let delayed = false
    window.studioAPI.jumpToNode = id => {
      const response = { state: JSON.parse(JSON.stringify(vm.status)), view: { ...base, currentNodeId: id } }
      if (!delayed) return Promise.resolve(response)
      return new Promise(resolve => requests.push(() => resolve(response)))
    }
    const settle = () => new Promise(resolve => setTimeout(resolve, 0))
    const wheel = direction => document.querySelector('.grid-main').dispatchEvent(
      new WheelEvent('wheel', { deltaY: direction * 100, bubbles: true, cancelable: true }))
    try {
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
    } finally {
      window.studioAPI.jumpToNode = async () => ({ state: JSON.parse(JSON.stringify(vm.status)), view: original })
      await vm.jumpToNode(original.currentNodeId)
      window.studioAPI.jumpToNode = originalJump
    }
  })
}
