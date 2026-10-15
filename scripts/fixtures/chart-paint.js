import { computed, createApp, h, ref } from 'vue'
import { useResponsiveGeometry } from '/src/useResponsiveGeometry.ts'
import { DEFAULT_PERCEPTUAL_SURFACE_TUNING, PERCEPTUAL_SURFACE_CHANGE_EVENT } from '/src/perceptualSurface.ts'
import { parseCssColor } from '/src/perceptualColor.ts'
import DistributionBarChart from '/src/components/DistributionBarChart.vue'

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
