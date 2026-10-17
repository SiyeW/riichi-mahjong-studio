import { createApp, h, nextTick, ref } from 'vue'
import DistributionBarChart from '/src/components/DistributionBarChart.vue'
import { DEFAULT_PERCEPTUAL_SURFACE_TUNING } from '/src/perceptualSurface.ts'

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => requestAnimationFrame(resolve)) }

export async function checkDistributionGeometry({ width, count, labels, animate = false, keep = false, resize = false }) {
  const host = document.createElement('div')
  host.style.cssText = `position:relative;left:.37px;top:.23px;width:${width}px;height:150px;--floating-panel-scale:1;--analysis-distribution-track-surface:rgb(20 72 81);--analysis-distribution-gap-color:rgba(1,42,49,.82)`
  document.querySelector('#fixture').append(host)
  const entries = ref(Array.from({ length: count }, (_, i) => ({ key: i, scale: 1, label: String(i), gapBefore: i > 0 && i % 7 === 0 })))
  const scale = ref(labels ? .6 : .3), reference = ref(null)
  const surface = { palette: { decisionRecommendation: [26,147,26], kamicha: [44,143,197], toimen: [211,154,58], shimocha: [76,175,80], selfDealIn: [201,85,77] }, tuning: DEFAULT_PERCEPTUAL_SURFACE_TUNING }
  const app = createApp({ setup: () => () => h(DistributionBarChart, {
    style: 'height:150px', entries: entries.value, colorVariable: labels ? '--analysis-dora-color' : '--analysis-score-color',
    reduceMotion: !animate, showLabels: labels, trackSurface: surface, probabilityScale: scale.value, referenceRatio: reference.value,
  }) })
  app.mount(host)
  try {
    await settle()
    const canvas = host.querySelector('canvas'), viewport = host.querySelector('.analysis-distribution-viewport')
    const tracks = canvas.rmsDistributionTracks
    if (tracks?.length !== count) throw Error('Missing real distribution geometry')
    const context = canvas.getContext('2d'), pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    const alpha = (x, y) => pixels.data[(y * canvas.width + x) * 4 + 3]
    const row = Math.floor((tracks[0].top + tracks[0].bottom) / 2)
    const bars = tracks.map(bar => ({ left: bar.left, width: bar.right - bar.left,
      allOpaque: Array.from({ length: bar.right - bar.left }, (_, x) => alpha(bar.left + x, row)).every(value => value === 255) }))
    const gaps = []
    for (let i = 1; i < tracks.length; i++) if (tracks[i].left > tracks[i - 1].right) {
      const left = tracks[i - 1].right, right = tracks[i].left
      gaps.push({ width: right - left, alphas: Array.from({ length: right - left }, (_, x) => alpha(left + x, row)) })
    }
    const rect = canvas.getBoundingClientRect()
    const cells = [...host.querySelectorAll('.analysis-distribution-cell')].map(cell => {
      const r = cell.getBoundingClientRect()
      return { left: (r.left - rect.left) * devicePixelRatio, width: r.width * devicePixelRatio }
    })
    const result = { bars, gaps, cells, pixelRatio: devicePixelRatio, count,
      cssWidth: rect.width * devicePixelRatio, bitmapWidth: canvas.width,
      originX: rect.left * devicePixelRatio, originY: rect.top * devicePixelRatio,
      overflow: viewport.scrollWidth > viewport.clientWidth + 1,
      axis: [...host.querySelectorAll('.analysis-probability-axis small')].map(e => e.textContent) }
    if (animate) {
      const samples = []
      scale.value = 1
      reference.value = .3
      entries.value = entries.value.map(entry => ({ ...entry, scale: .4 }))
      await nextTick()
      for (let i = 0; i < 13; i++) {
        await new Promise(resolve => requestAnimationFrame(resolve))
        const axis = host.querySelector('.analysis-probability-axis')
        const tick = axis.children[1]
        const inferred = .05 / (1 - parseFloat(tick.style.top) / 100)
        const guide = canvas.rmsDistributionGuideBounds
        const track = canvas.rmsDistributionTracks[0]
        samples.push({ scale: inferred, guideRatio: guide ? (track.bottom - guide.top) / (track.bottom - track.top) : null })
      }
      result.samples = samples
    }
    if (resize) {
      result.resizes = []
      for (const nextWidth of [70.23, 320.61, width]) {
        host.style.width = `${nextWidth}px`
        host.style.setProperty('--floating-panel-scale', nextWidth > 300 ? '1.25' : '.85')
        await settle()
        const current = canvas.rmsDistributionTracks
        const box = canvas.getBoundingClientRect()
        viewport.scrollLeft = viewport.scrollWidth
        await settle()
        const last = host.querySelector('.analysis-distribution-cell:last-child').getBoundingClientRect()
        const visible = viewport.getBoundingClientRect()
        result.resizes.push({
          widths: current.map(bar => bar.right - bar.left),
          cssWidth: box.width * devicePixelRatio, bitmapWidth: canvas.width,
          lastVisible: last.right <= visible.right + 1 / devicePixelRatio,
          lastRight: last.right, visibleRight: visible.right, scroll: viewport.scrollLeft,
        })
        viewport.scrollLeft = 0
        await settle()
      }
    }
    return result
  } finally { if (!keep) { app.unmount(); host.remove() } }
}
