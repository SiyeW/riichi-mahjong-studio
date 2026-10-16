import '../../../src/styles.css'
import '../../../src/styles/TableScene.css'
import './preview.css'
import faceSource from '../../../src/assets/tiles/Regular_shortnames/5m.svg'
import backSource from '../../../src/assets/tiles/Regular_shortnames/back.svg'
import { getUiMotionDurationMs, getUiMotionEasingFunction } from '../../../src/uiMotion.ts'
import { motionSample, sampledTime, sweepOffsets, sweepSampleCount, updateInterval } from './model.ts'

type Options = { every: number; seat: number; reverse: boolean; scale: number; distance: number;
  exposure: number; autoExposure: boolean; blur: boolean; reveal: boolean; diagonal: boolean; loop: boolean; reduced: boolean }
const options: Options = { every: 1, seat: 3, reverse: false, scale: 1.5, distance: 400, exposure: 3, autoExposure: true, blur: true, reveal: false, diagonal: false, loop: false, reduced: false }
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!
const duration = getUiMotionDurationMs(), ease = getUiMotionEasingFunction()
$('#time').setAttribute('max', String(duration))
const media = matchMedia('(prefers-reduced-motion: reduce)')
const forcedFallback = new URLSearchParams(location.search).has('noFilter')
const capable = !forcedFallback && typeof SVGFEOffsetElement !== 'undefined' && typeof SVGFECompositeElement !== 'undefined'
  && typeof SVGFEGaussianBlurElement !== 'undefined'
  && typeof CSS !== 'undefined' && CSS.supports('filter', 'url("#motion-blur")')
const filter = $<SVGFilterElement & HTMLElement>('#motion-blur')
let offsets: SVGFEOffsetElement[] = []
let reconstruction: SVGFEGaussianBlurElement | null = null
let coverageSupported = true
const panels = [...document.querySelectorAll<HTMLElement>('.stage')].map(stage => {
  stage.innerHTML = '<div class="sprite"><div class="direction"><div class="artwork"><img class="tileImg face" alt="五萬"><img class="tileImg back" alt="" aria-hidden="true"></div></div></div>'
  const face = stage.querySelector<HTMLImageElement>('.face')!, back = stage.querySelector<HTMLImageElement>('.back')!
  face.src = faceSource; back.src = backSource
  return { stage, sprite: stage.querySelector<HTMLElement>('.sprite')!, direction: stage.querySelector<HTMLElement>('.direction')!,
    artwork: stage.querySelector<HTMLElement>('.artwork')!, face, back }
})
let frame = 0, generation = 0, disposed = false, ready = false, shownTime = 0
let geometry = { width: 0, height: 0, distance: 0, dx: 0, dy: 0, startX: 0, startY: 0, angle: 0 }

function buildSweep() {
  const count = sweepSampleCount(geometry.distance, Math.min(geometry.width, geometry.height))
  coverageSupported = geometry.distance / (count - 1) <= Math.min(geometry.width, geometry.height) * 0.5
  filter.replaceChildren()
  offsets = []
  reconstruction = null
  if (!capable) return
  for (let index = 0; index < count; index++) {
    const offset = document.createElementNS('http://www.w3.org/2000/svg', 'feOffset')
    offset.setAttribute('in', 'SourceGraphic'); offset.setAttribute('result', `tap-${index}`)
    offset.setAttribute('dy', '0'); filter.append(offset); offsets.push(offset)
    if (!index) continue
    const average = document.createElementNS('http://www.w3.org/2000/svg', 'feComposite')
    average.setAttribute('in', `tap-${index}`); average.setAttribute('in2', index === 1 ? 'tap-0' : `average-${index - 1}`)
    average.setAttribute('operator', 'arithmetic'); average.setAttribute('k2', String(1 / (index + 1)))
    average.setAttribute('k3', String(index / (index + 1))); average.setAttribute('result', `average-${index}`)
    filter.append(average)
  }
  // Reconstruct between discrete spatial taps instead of leaving repeated
  // high-contrast glyphs. This follows the complete sweep; it does not replace
  // it with a short blur centered on the current tile.
  reconstruction = document.createElementNS('http://www.w3.org/2000/svg', 'feGaussianBlur')
  reconstruction.setAttribute('in', `average-${count - 1}`)
  filter.append(reconstruction)
}

function layout() {
  $('.preview').style.setProperty('--zoom', String(options.scale))
  const imageStyle = getComputedStyle(panels[0]!.face)
  const width = parseFloat(imageStyle.width), height = parseFloat(imageStyle.height)
  const extent = Math.hypot(width, height)
  const angle = (-90 - options.seat * 90 + (options.diagonal ? 30 : 0)) * Math.PI / 180
  const unitX = Math.cos(angle), unitY = Math.sin(angle)
  const distance = Math.max(0, Math.min(options.distance,
    (panels[0]!.stage.clientWidth - 2 * extent) / Math.max(0.000001, Math.abs(unitX)),
    (panels[0]!.stage.clientHeight - 2 * extent) / Math.max(0.000001, Math.abs(unitY))))
  const dx = unitX * distance, dy = unitY * distance
  const sign = options.reverse ? -1 : 1
  geometry = { width, height, distance, dx: dx * sign, dy: dy * sign,
    startX: panels[0]!.stage.clientWidth / 2 - dx * sign / 2,
    startY: panels[0]!.stage.clientHeight / 2 - dy * sign / 2, angle: Math.atan2(dy * sign, dx * sign) * 180 / Math.PI }
  filter.setAttribute('x', String(-distance - extent)); filter.setAttribute('y', String(-extent))
  filter.setAttribute('width', String(width + distance + extent * 2)); filter.setAttribute('height', String(height + extent * 2))
  buildSweep()
  for (const panel of panels) {
    panel.direction.style.transform = `rotate(${geometry.angle}deg)`
    panel.artwork.style.transform = `rotate(${-geometry.angle - options.seat * 90}deg)`
  }
}

function draw(time: number, submittedInterval?: number, coverLanding = false) {
  shownTime = Math.max(0, Math.min(duration, time))
  const reduced = media.matches || options.reduced
  const exposure = options.autoExposure ? Math.max(updateInterval(165, options.every), submittedInterval ?? 0) : options.exposure
  const sharpEndpoint = reduced || (shownTime === duration && !coverLanding)
  const sample = motionSample(reduced ? duration : shownTime, duration, geometry.distance, sharpEndpoint ? 0 : exposure, options.reverse, ease)
  const enabled = capable && coverageSupported && options.blur && !reduced && sample.blurLength > 0
  if (enabled) {
    const positions = sweepOffsets(sample.blurLength, offsets.length)
    offsets.forEach((offset, index) => offset.setAttribute('dx', String(positions[index])))
    reconstruction?.setAttribute('stdDeviation', `${sample.blurLength / (offsets.length - 1) * 0.5} 0`)
  }
  for (const panel of panels) {
    panel.sprite.style.transform = `translate3d(${geometry.startX + geometry.dx * sample.progress - geometry.width / 2}px, ${geometry.startY + geometry.dy * sample.progress - geometry.height / 2}px, 0)`
    panel.direction.style.filter = panel.stage.dataset.pane === 'blur' && enabled ? 'url("#motion-blur")' : 'none'
    panel.back.style.opacity = String(options.reveal ? sample.backOpacity : 0)
  }
  $<HTMLInputElement>('#time').value = String(shownTime)
  $('#time-value').textContent = `${shownTime.toFixed(1)}ms`
  const exposureInput = $<HTMLInputElement>('[name="exposure"]')
  exposureInput.disabled = options.autoExposure
  if (options.autoExposure) exposureInput.value = exposure.toFixed(2)
  $('#state').textContent = `${!capable || !coverageSupported ? '效果不可用：已回退到清晰图像。' : reduced ? '减少动态效果：不播放、不模糊。' : '轨迹覆盖近似，仍需目视比较。'} 实际距离 ${Math.round(geometry.distance)}px · 曝光 ${exposure.toFixed(2)}ms · 覆盖 ${sample.blurLength.toFixed(1)}px`
  return { time: shownTime, ...sample, exposure, samples: offsets.length, coverageSupported, enabled, capable, reduced, geometry, pendingFrame: frame !== 0 }
}
export function seek(time: number) { return draw(time) }

export function stop() { generation++; if (frame) cancelAnimationFrame(frame); frame = 0 }
export function play() {
  stop()
  if (!ready || disposed || media.matches || options.reduced) { seek(duration); return }
  const owner = generation, start = performance.now()
  let previous = 0, lastCycle = 0, settling = false
  draw(0)
  const tick = (now: number) => {
    if (owner !== generation || disposed) return
    frame = 0
    if (settling) {
      draw(duration, 0)
      settling = false
      if (!options.loop) return
    }
    const elapsed = now - start, cycle = duration + 700
    const cycleIndex = options.loop ? Math.floor(elapsed / cycle) : 0
    if (cycleIndex !== lastCycle) { previous = 0; lastCycle = cycleIndex; draw(0) }
    const current = sampledTime(options.loop ? elapsed % cycle : elapsed, duration, 165, options.every)
    if (current !== previous) {
      draw(current, current - previous, current === duration)
      previous = current
      settling = current === duration
    }
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
}
export function configure(changes: Partial<Options>) {
  stop(); Object.assign(options, changes)
  options.every = Math.max(1, Math.min(3, Math.round(options.every)))
  options.seat = Math.max(0, Math.min(3, Math.round(options.seat)))
  options.scale = Math.max(0.7, Math.min(2.5, options.scale))
  options.exposure = Math.max(0, Math.min(duration, options.exposure))
  options.distance = Math.max(100, Math.min(600, options.distance))
  for (const [name, value] of Object.entries(options)) {
    const control = $<HTMLFormElement>('#controls').elements.namedItem(name)
    if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = Boolean(value)
    else if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) control.value = String(['reverse', 'autoExposure'].includes(name) ? Number(value) : value)
  }
  layout(); return seek(shownTime)
}
const controlChange = (event: Event) => {
  const target = event.target as HTMLInputElement | HTMLSelectElement
  configure({ [target.name]: target instanceof HTMLInputElement && target.type === 'checkbox' ? target.checked : ['reverse', 'autoExposure'].includes(target.name) ? target.value === '1' : Number(target.value) })
}
const scrub = () => { stop(); seek(Number($<HTMLInputElement>('#time').value)) }
const resized = () => { stop(); layout(); seek(shownTime) }
const visibility = () => { if (document.hidden) { stop(); seek(duration) } }
$('#controls').addEventListener('change', controlChange)
$('#play').addEventListener('click', play); $('#stop').addEventListener('click', stop)
$('#time').addEventListener('input', scrub)
media.addEventListener('change', resized); document.addEventListener('visibilitychange', visibility)
const observer = new ResizeObserver(resized); panels.forEach(panel => observer.observe(panel.stage))
export function dispose() {
  if (disposed) return
  disposed = true; stop(); observer.disconnect()
  window.removeEventListener('pagehide', dispose)
  media.removeEventListener('change', resized); document.removeEventListener('visibilitychange', visibility)
  $('#controls').removeEventListener('change', controlChange)
  $('#play').removeEventListener('click', play); $('#stop').removeEventListener('click', stop); $('#time').removeEventListener('input', scrub)
  panels.forEach(panel => { panel.direction.style.filter = 'none' })
}
window.addEventListener('pagehide', dispose, { once: true })
if (import.meta.hot) import.meta.hot.dispose(dispose)
try {
  await Promise.all(panels.flatMap(panel => [panel.face, panel.back]).map(image => image.decode()))
  if (!disposed) { ready = true; layout(); seek(0); $<HTMLButtonElement>('#play').disabled = false; document.body.dataset.ready = 'true' }
} catch { $('#state').textContent = '牌画载入失败，未播放。' }
