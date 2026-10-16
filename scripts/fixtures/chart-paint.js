import { computed, createApp, h, nextTick, ref } from 'vue'
import { useResponsiveGeometry } from '/src/useResponsiveGeometry.ts'
import { DEFAULT_PERCEPTUAL_SURFACE_TUNING, PERCEPTUAL_SURFACE_CHANGE_EVENT } from '/src/perceptualSurface.ts'
import { parseCssColor } from '/src/perceptualColor.ts'
import DistributionBarChart from '/src/components/DistributionBarChart.vue'
import ShantenPieChart from '/src/components/ShantenPieChart.vue'
import GameAnalysisSection from '/src/components/GameAnalysisSection.vue'
import { useAnalysisHoverTooltip } from '/src/useAnalysisHoverTooltip.ts'

const settle = async () => {
  for (let frame = 0; frame < 3; frame++) await new Promise(resolve => requestAnimationFrame(resolve))
}

export async function checkSurfacePaintRouting() {
  const host = document.createElement('div'), unrelated = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-1000px;top:0;width:100px;height:20px'
  document.body.append(host, unrelated)
  let updates = 0, added = 0, removed = 0
  const add = document.addEventListener, remove = document.removeEventListener
  document.addEventListener = function (type, ...args) {
    if (type === PERCEPTUAL_SURFACE_CHANGE_EVENT) added++
    return add.call(this, type, ...args)
  }
  document.removeEventListener = function (type, ...args) {
    if (type === PERCEPTUAL_SURFACE_CHANGE_EVENT) removed++
    return remove.call(this, type, ...args)
  }
  const visible = ref(true)
  let mounted = false
  const app = createApp({ setup() {
    const element = ref(null)
    useResponsiveGeometry(element, () => { updates++ })
    return () => visible.value ? h('div', { ref: element, style: 'width:100px;height:20px' }, [h('span', 'paint')]) : null
  } })
  try {
    app.mount(host)
    mounted = true
    await settle()
    const send = async (owner, count = 1) => {
      const before = updates
      for (let event = 0; event < count; event++) owner.dispatchEvent(new CustomEvent(PERCEPTUAL_SURFACE_CHANGE_EVENT))
      await settle()
      return updates - before
    }
    const own = await send(host.firstElementChild)
    const ancestor = await send(host)
    const descendant = await send(host.querySelector('span'))
    const foreign = await send(unrelated)
    const coalesced = await send(host, 20)
    visible.value = false
    await settle()
    const detached = await send(host)
    visible.value = true
    await settle()
    const replacement = await send(host)
    app.unmount()
    mounted = false
    const unmounted = await send(document.body)
    return { own, ancestor, descendant, foreign, coalesced, detached, replacement, unmounted, added, removed }
  } finally {
    if (mounted) app.unmount()
    document.addEventListener = add
    document.removeEventListener = remove
    host.remove(); unrelated.remove()
  }
}

export async function checkDistributionPalettePaint() {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:60px'
  document.body.append(host)
  const palette = ref({ decisionRecommendation: [26, 147, 26], kamicha: [44, 143, 197],
    toimen: [211, 154, 58], shimocha: [76, 175, 80], selfDealIn: [201, 85, 77] })
  const surface = computed(() => ({ palette: palette.value, tuning: DEFAULT_PERCEPTUAL_SURFACE_TUNING }))
  const entries = [{ key: 0, scale: 1 }]
  const app = createApp({ setup: () => () => h(DistributionBarChart, {
    id: 'paint-check-distribution', style: 'display:flex;width:100px;height:60px',
    entries, colorVariable: '--analysis-dora-color', reduceMotion: true, showLabels: false, trackSurface: surface.value,
  }) })
  try {
    app.mount(host)
    await settle(); await settle()
    const before = sampleDistributionColor('#paint-check-distribution', '--analysis-dora-color')
    palette.value = { ...palette.value, kamicha: [33, 150, 243] }
    await settle(); await settle()
    const after = sampleDistributionColor('#paint-check-distribution', '--analysis-dora-color')
    return { before, after }
  } finally { app.unmount(); host.remove() }
}

export async function checkShantenPaintUpdates() {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:0;top:0;width:150px;--shanten-pie-size:150px;--ron-tile-w:30px;--floating-text-chart-viewbox:.22px'
  document.body.append(host)
  const probabilities = ref([0.6, 0.3, 0.1, 0, 0, 0, 0, 0])
  const colors = ref(['#4caf50', '#2b8cbe', '#1476b0', '#0868ac', '#08589e', '#084081', '#062b5c', '#4e6263'])
  const labels = ['0', '1', '2', '3', '4', '5', '6', '7+']
  const app = createApp({ setup: () => () => h(ShantenPieChart, {
    label: 'paint check', probabilities: probabilities.value, colors: colors.value,
    sliceLabels: labels, shortLabels: labels, reduceMotion: false,
  }) })
  let observer
  let mounted = false
  try {
    app.mount(host)
    mounted = true
    await settle()
    const svg = host.querySelector('svg'), path = svg.querySelector('path')
    let writes = 0
    observer = new MutationObserver(records => { writes += records.filter(record => ['d', 'x', 'y', 'stroke-width', 'tabindex', 'style'].includes(record.attributeName)).length })
    observer.observe(svg, { subtree: true, attributes: true })
    colors.value = [...colors.value]
    await settle()
    const unchangedWrites = writes
    const oldPath = path.getAttribute('d'), changedPaths = []
    observer.disconnect()
    observer = new MutationObserver(records => {
      if (records.some(record => record.target === path && record.attributeName === 'd')) changedPaths.push(path.getAttribute('d'))
    })
    observer.observe(svg, { subtree: true, attributes: true })
    probabilities.value = [0.1, 0.7, 0.2, 0, 0, 0, 0, 0]
    await nextTick(); await nextTick()
    // Controlled scheduling delay, NOT a performance sample. The first drawing
    // callback must still show an intermediate rather than consume all 110ms.
    const start = performance.now()
    while (performance.now() - start < 150) { /* Simulate a late first callback. */ }
    await new Promise(resolve => setTimeout(resolve, 180))
    const finalPath = path.getAttribute('d')
    const result = { unchangedWrites, oldPath, firstChangedPath: changedPaths[0], finalPath,
      zeroPaths: [...svg.querySelectorAll('path')].slice(3).map(element => ({ path: element.getAttribute('d'), tabindex: element.getAttribute('tabindex') })) }
    probabilities.value = [0.7, 0.2, 0.1, 0, 0, 0, 0, 0]
    await nextTick()
    app.unmount()
    mounted = false
    const afterUnmount = changedPaths.length
    await new Promise(resolve => setTimeout(resolve, 150))
    result.writesAfterUnmount = changedPaths.length - afterUnmount
    return result
  } finally { observer?.disconnect(); if (mounted) app.unmount(); host.remove() }
}

export async function checkUnchangedGamePaint(seed) {
  const host = document.createElement('div')
  host.className = 'shell'
  host.style.cssText = 'position:fixed;left:-1000px;top:0;width:600px;height:500px;--floating-panel-scale:1'
  document.body.append(host)
  const analysis = ref(seed.analysis)
  const app = createApp({ setup() {
    useAnalysisHoverTooltip(ref(host))
    return () => h(GameAnalysisSection, { ...seed, analysis: analysis.value, reduceMotion: false })
  } })
  let context, originalClear
  try {
    app.mount(host)
    await settle(); await new Promise(resolve => setTimeout(resolve, 180))
    const canvas = host.querySelector('canvas')
    context = canvas.getContext('2d'); originalClear = context.clearRect
    let draws = 0
    context.clearRect = function (...args) { draws++; return originalClear.apply(this, args) }
    const before = canvas.rmsGameAnalysisRenderSignature
    analysis.value = { ...analysis.value, context: { ...analysis.value?.context, nodeId: 'same-values-new-wrapper' } }
    await new Promise(resolve => setTimeout(resolve, 180))
    const unchanged = before === canvas.rmsGameAnalysisRenderSignature, unchangedDraws = draws
    analysis.value = { status: 'unavailable', outputs: {} }
    await new Promise(resolve => setTimeout(resolve, 180))
    const root = canvas.getBoundingClientRect(), track = host.querySelector('.analysis-outcome-bar').getBoundingClientRect()
    const x = Math.min(canvas.width - 1, Math.max(0, Math.round(((track.left + track.right) / 2 - root.left) * devicePixelRatio)))
    const y = Math.min(canvas.height - 1, Math.max(0, Math.round(((track.top + track.bottom) / 2 - root.top) * devicePixelRatio)))
    const emptyOutcomeAlpha = context.getImageData(x, y, 1, 1).data[3]
    return { draws: unchangedDraws, unchanged, emptyOutcomeAlpha, width: canvas.width, height: canvas.height }
  } finally { if (context && originalClear) context.clearRect = originalClear; app.unmount(); host.remove() }
}

export function sampleDistributionColor(selector, variable) {
  const chart = document.querySelector(selector), canvas = chart?.querySelector('canvas')
  const track = chart?.querySelector('.analysis-distribution-track')
  if (!canvas || !track) throw new Error('Missing painted distribution')
  const root = canvas.getBoundingClientRect(), box = track.getBoundingClientRect()
  const ratio = devicePixelRatio
  const x = Math.round((box.left - root.left + box.width / 2) * ratio)
  const y = Math.round((box.bottom - root.top) * ratio) - 3
  const pixel = [...canvas.getContext('2d').getImageData(x, y, 1, 1).data]
  const expected = parseCssColor(getComputedStyle(chart).getPropertyValue(variable), [0, 0, 0])
  return { pixel, expected, matches: expected.every((value, index) => value === pixel[index]) && pixel[3] === 255 }
}
