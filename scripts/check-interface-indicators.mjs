import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

export async function checkTableTurnIndicators(page) {
  const original = await page.evaluate(() => ({ mode: window.analysisCheck.vm.status.mode,
    table: JSON.parse(JSON.stringify(window.analysisCheck.vm.gameView.table)),
    scale: window.analysisCheck.vm.settings.display.uiScale }))
  const screenshotDirectory = process.env.RMS_UI_INDICATOR_SCREENSHOT_DIR
  if (screenshotDirectory) fs.mkdirSync(screenshotDirectory, { recursive: true })
  const read = () => page.locator('.grid-info').evaluate(center => {
    const style = getComputedStyle(center)
    const colorProbe = document.createElement('span')
    colorProbe.style.color = 'var(--text-main)'
    center.append(colorProbe)
    const main = getComputedStyle(colorProbe).color
    colorProbe.style.color = 'var(--text-soft)'
    const soft = getComputedStyle(colorProbe).color
    colorProbe.remove()
    const centerRect = center.getBoundingClientRect()
    return {
      scale: Number(style.getPropertyValue('--center-ui-scale')),
      main, soft, rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
      items: [...center.querySelectorAll('.gi-player-anchor > span')].map(item => {
        const base = getComputedStyle(item)
        const mark = getComputedStyle(item, '::after')
        const seat = getComputedStyle(item.querySelector('.gi-seat'))
        const seatTransform = new DOMMatrixReadOnly(seat.transform)
        const rect = item.getBoundingClientRect()
        return { actor: item.classList.contains('is-actor'), color: mark.backgroundColor,
          content: mark.content, height: parseFloat(mark.height), bottom: parseFloat(mark.bottom),
          left: parseFloat(mark.left), right: parseFloat(mark.right), pointer: mark.pointerEvents,
          border: parseFloat(base.borderTopWidth), background: base.backgroundColor,
          width: rect.width, stripHeight: rect.height, transform: base.transform,
          seatAlign: seat.textAlign, seatX: seatTransform.m41, seatY: seatTransform.m42,
          betTransform: getComputedStyle(item.querySelector('.gi-riichi-bet')).transform,
          text: [...item.children].map(child => {
            const textRect = child.getBoundingClientRect()
            return [textRect.x - centerRect.x, textRect.y - centerRect.y, textRect.width, textRect.height]
          }) }
      }),
    }
  })
  try {
    for (const scale of [1, 1.65]) {
      await page.evaluate(scale => { window.analysisCheck.vm.settings.display.uiScale = scale }, scale)
      for (const mode of ['research', 'play']) {
        let baseline
        for (const actor of [0, 1, 2, 3]) {
          await page.evaluate(({ mode, actor }) => {
            const vm = window.analysisCheck.vm
            vm.status.mode = mode
            vm.gameView.table.phase = 'draw'
            vm.gameView.table.currentActor = actor
          }, { mode, actor })
          // Let viewport ownership settle after mode/UI-scale layout changes.
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          const result = await read()
          const active = result.items.filter(item => item.actor)
          assert.equal(active.length, 1, 'exactly one eligible player has a turn mark')
          assert.ok(result.items.every(item => item.border === 0 && item.background === 'rgba(0, 0, 0, 0)'), 'turn state no longer paints a frame or background')
          assert.ok(Math.abs(active[0].height - 3 * result.scale) < 0.05, 'table line shares the scaled indicator thickness')
          assert.ok(Math.abs(active[0].bottom + 3 * result.scale) < 0.05 && active[0].left > 0
            && Math.abs(active[0].right + result.rem * result.scale) < 0.05, 'line preserves the tuned bottom offset and right overhang')
          assert.equal(active[0].pointer, 'none', 'the decorative line cannot intercept input')
          assert.equal(active[0].color, mode === 'research' ? result.soft : result.main, 'research uses soft text color; play uses main text color')
          assert.ok(result.items.every(item => item.seatAlign === 'left'
            && Math.abs(item.seatX + 4.5 * result.scale) < 0.05
            && Math.abs(item.seatY + 0.5 * result.scale) < 0.05
            && item.betTransform === 'none'), 'all four seats preserve the tuned wind and riichi-bet alignment')
          assert.ok(result.items.filter(item => !item.actor).every(item => item.content === 'none'))
          const geometry = result.items.map(({ width, stripHeight, text, transform }) => ({ width, stripHeight, text, transform }))
          if (baseline) assert.deepEqual(geometry, baseline, 'changing actor does not move scores, winds or riichi bets')
          else baseline = geometry
          if (scale === 1 && screenshotDirectory && ((mode === 'research' && actor === 0) || (mode === 'play' && actor === 3))) {
            await page.locator('.grid-info').screenshot({ path: path.join(screenshotDirectory, `table-${mode}.png`) })
          }
        }
        for (const phase of ['round_result', 'game_end', 'match_end']) {
          await page.evaluate(phase => { window.analysisCheck.vm.gameView.table.phase = phase }, phase)
          assert.equal(await page.locator('.grid-info .is-actor').count(), 0, 'result frames have no current-turn underline')
        }
      }
    }
  } finally {
    await page.evaluate(original => {
      const vm = window.analysisCheck.vm
      vm.status.mode = original.mode
      vm.gameView.table = original.table
      vm.settings.display.uiScale = original.scale
    }, original)
  }
}

export async function checkIndicatorFamily(page) {
  const result = await page.evaluate(() => {
    const profile = document.querySelector('.engine-profile-item.selected')
    const meter = document.querySelector('.resource-track')
    const slider = document.querySelector('.quick-time-track-fill')
    const selected = getComputedStyle(profile, '::before')
    const neutral = getComputedStyle(meter.firstElementChild)
    const control = getComputedStyle(slider)
    return { selected: selected.backgroundColor, neutral: neutral.backgroundColor,
      selectedThickness: parseFloat(selected.width) / Number(getComputedStyle(profile).getPropertyValue('--floating-panel-scale')),
      meterThickness: parseFloat(getComputedStyle(meter).height) / Number(getComputedStyle(meter).getPropertyValue('--chrome-scale')),
      meterRadius: getComputedStyle(meter).borderTopLeftRadius,
      sliderRadius: getComputedStyle(slider).borderTopLeftRadius, sliderColor: control.backgroundColor,
      sliderCursor: getComputedStyle(document.querySelector('.quick-time-range')).cursor,
      thumbSize: parseFloat(getComputedStyle(document.querySelector('.quick-time-thumb')).width) }
  })
  assert.equal(result.selected, result.neutral, 'engine selection and passive meters share the neutral indicator color')
  assert.ok(Math.abs(result.selectedThickness - 3) < 0.05 && Math.abs(result.meterThickness - 3) < 0.05)
  assert.equal(result.meterRadius, '0px', 'passive meters keep square ends')
  assert.notEqual(result.sliderColor, result.neutral, 'interactive controls retain their separate accent')
  assert.notEqual(result.sliderRadius, '0px')
  assert.equal(result.sliderCursor, 'pointer')
  assert.ok(result.thumbSize > result.meterThickness, 'the slider retains its draggable thumb')
}
