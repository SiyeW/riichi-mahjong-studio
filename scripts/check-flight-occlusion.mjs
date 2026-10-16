import assert from 'node:assert/strict'

// Compare opaque interior pixels at an annotation crossing, not just the DOM
// rectangles: a correctly aligned face/back can still be painted over.
export async function checkFlightOcclusion(page) {
  await page.evaluate(() => {
    const { vm } = window.analysisCheck
    window.rmsOcclusionOriginal = { view: JSON.parse(JSON.stringify(vm.gameView)),
      jump: window.studioAPI.jumpToNode, animate: Element.prototype.animate }
    window.rmsOcclusionAnimations = []
    Element.prototype.animate = function (...args) {
      const animation = window.rmsOcclusionOriginal.animate.apply(this, args)
      animation.pause()
      animation.currentTime = 0
      window.rmsOcclusionAnimations.push(animation)
      return animation
    }
  })
  const cases = []
  try {
    for (const actor of [0, 1, 2, 3]) for (const riichi of [false, true]) for (const reverse of [false, true]) {
      await page.evaluate(async ({ actor, riichi, reverse }) => {
        const { vm } = window.analysisCheck
        const parent = structuredClone(window.rmsOcclusionOriginal.view)
        parent.playerNames = ['', '', '', '']
        parent.currentNodeId = `occlusion-parent-${actor}`
        parent.table.pendingDiscard = null
        parent.table.pendingRiichiDiscard = null
        parent.table.hands[actor] = ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p', '5p']
        parent.table.rivers[actor] = []
        parent.table.actionHistory = [{ type: 'tsumo', actor, pai: '5p' }]
        const child = structuredClone(parent)
        child.currentNodeId = `occlusion-child-${actor}`
        child.table.hands[actor].pop()
        child.table.pendingDiscard = { actor, pai: '5p', tsumogiri: true, targetActor: actor, riichi }
        child.table.actionHistory.push({ type: 'dahai', actor, pai: '5p', tsumogiri: true })
        parent.tree = child.tree = { rootNodeId: parent.currentNodeId, currentNodeId: parent.currentNodeId,
          currentRoundRootId: parent.currentNodeId, revision: 1, rounds: [], nodes: [
            { id: parent.currentNodeId, parentId: null, children: [child.currentNodeId], depth: 0 },
            { id: child.currentNodeId, parentId: parent.currentNodeId, children: [], depth: 1 },
          ] }
        window.studioAPI.jumpToNode = async id => ({ state: JSON.parse(JSON.stringify(vm.status)),
          view: id === child.currentNodeId ? child : parent })
        await vm.jumpToNode(parent.currentNodeId)
        await new Promise(resolve => requestAnimationFrame(resolve))
        window.rmsOcclusionAnimations = []
        await vm.jumpToNode(child.currentNodeId)
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        if (reverse) {
          window.rmsOcclusionAnimations = []
          await vm.jumpToNode(parent.currentNodeId)
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        }
      }, { actor, riichi, reverse })
      for (const annotation of ['empty', 'named', 'hover', 'editing']) {
        await page.mouse.move(0, 0)
        await page.evaluate(({ actor, annotation }) => {
          window.analysisCheck.vm.gameView.playerNames[actor] = annotation === 'empty' ? '' : 'Player g'
        }, { actor, annotation })
        const button = page.locator(`[data-player-seat="${actor}"] .player-name-button`)
        if (annotation === 'hover') {
          try { await button.hover() }
          catch (error) {
            console.error('Occlusion hover fixture', { actor, riichi, reverse, annotation }, await page.evaluate(() => ({
              node: window.analysisCheck.vm.gameView.currentNodeId,
              pending: window.analysisCheck.vm.gameView.table.pendingDiscard,
              rivers: window.analysisCheck.vm.gameView.table.rivers,
              animations: window.rmsOcclusionAnimations.map(animation => ({ target: animation.effect.target.className, connected: animation.effect.target.isConnected, state: animation.playState })),
            })))
            throw error
          }
        }
        if (annotation === 'editing') await button.click()
        const clip = await page.evaluate(({ actor, reverse }) => {
          const target = reverse ? document.querySelector('.discard-return-ghost')
            : document.querySelector(`[data-pending-discard-seat="${actor}"]`)
          const movement = window.rmsOcclusionAnimations.find(animation => animation.effect.target === target)
          if (!target || !movement) throw new Error('Occlusion fixture must exercise the real flight')
          const face = target.querySelector('.tileImg:not(.discard-flight-back)')
          const editor = document.querySelector(`[data-player-seat="${actor}"] input, [data-player-seat="${actor}"] button`)
          const anchor = editor.getBoundingClientRect()
          const before = face.getBoundingClientRect()
          const matrix = getComputedStyle(target).transform
          const transform = `translate(${anchor.x + anchor.width / 2 - before.x - before.width / 2}px, ${anchor.y + anchor.height / 2 - before.y - before.height / 2}px) ${matrix === 'none' ? '' : matrix}`
          movement.effect.setKeyframes([{ transform }, { transform }])
          movement.currentTime = 20
          // Keep the face/pose at its opaque endpoint. A deliberately translucent
          // crossfade could legitimately reveal a differently painted background.
          window.rmsOcclusionAnimations.filter(animation => animation !== movement).forEach(animation => { animation.currentTime = 0 })
          // Exercise the existing input quiet guard without navigating the table.
          window.dispatchEvent(new WheelEvent('wheel'))
          const rect = face.getBoundingClientRect()
          if (Math.abs(rect.x + rect.width / 2 - anchor.x - anchor.width / 2) > 1
            || Math.abs(rect.y + rect.height / 2 - anchor.y - anchor.height / 2) > 1) throw new Error('Flight did not cross its actual editor')
          return { x: Math.ceil(rect.x + rect.width * .25), y: Math.ceil(rect.y + rect.height * .25),
            width: Math.max(1, Math.floor(rect.width * .5)), height: Math.max(1, Math.floor(rect.height * .5)) }
        }, { actor, reverse })
        const visible = await page.screenshot({ clip, animations: 'allow' })
        // Opacity keeps a focused inline editor mounted; visibility would blur
        // and commit it, changing more than the paint under comparison.
        await page.locator('.table-player-names').evaluate(element => { element.style.opacity = '0' })
        const unobstructed = await page.screenshot({ clip, animations: 'allow' })
        await page.locator('.table-player-names').evaluate(element => { element.style.removeProperty('opacity') })
        assert.ok(visible.equals(unobstructed), `Annotation painted over a flying tile: ${JSON.stringify({ actor, riichi, reverse, annotation })}`)
        if (annotation === 'editing') await page.locator('.player-name-input').press('Escape')
        cases.push({ actor, riichi, reverse, annotation })
      }
    }
  } finally {
    await page.evaluate(async () => {
      const { vm } = window.analysisCheck, original = window.rmsOcclusionOriginal
      Element.prototype.animate = original.animate
      document.querySelector('.table-player-names')?.style.removeProperty('opacity')
      window.studioAPI.jumpToNode = async () => ({ state: JSON.parse(JSON.stringify(vm.status)), view: original.view })
      await vm.jumpToNode(original.view.currentNodeId)
      window.studioAPI.jumpToNode = original.jump
      delete window.rmsOcclusionOriginal
      delete window.rmsOcclusionAnimations
    })
  }
  console.log(`Flight/annotation pixel occlusion: ${cases.length} supported cases passed.`)
}
