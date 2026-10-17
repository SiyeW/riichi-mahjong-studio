import '../../../src/styles.css'
import '../../../src/styles/TableScene.css'
import '../../../src/components/TableRivers.css'
import sourceUrl from '../../../src/assets/tiles/Regular_shortnames/5m.svg'
import { createDiscardCoverageRenderer } from '../../../src/discardMotion/coverage.ts'
import { getUiMotionDurationMs, getUiMotionEasing } from '../../../src/uiMotion.ts'
import unsupportedWorkerUrl from './no-webgl.worker.js?worker&url'

async function boot() {
  if (new URLSearchParams(location.search).has('no-webgl')) {
    const NativeWorker = Worker
    window.Worker = class extends NativeWorker {
      constructor(_url, options) { super(unsupportedWorkerUrl, options) }
    }
  }
  document.body.style.cssText = 'margin:0;background:#02191e;--zoom:1.5'
  const source = document.querySelector('.tileDiv'), image = source.querySelector('img')
  image.src = sourceUrl; await image.decode()
  source.style.setProperty('opacity', '.8', 'important')
  const renderer = createDiscardCoverageRenderer()
  let movement
  try {
    renderer.start()
    const deadline = performance.now() + 6000
    while (!renderer.ready && document.querySelector('.discard-motion-surface')) {
      if (performance.now() > deadline) throw Error('Compiled worker/artwork warmup timed out')
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    const duration = getUiMotionDurationMs(), easing = getUiMotionEasing()
    if (duration !== 110) throw Error('Compiled fixture changed the shared duration')
    movement = source.animate([{ transform: 'translateX(0px)' }, { transform: 'translateX(300px)' }], { duration, easing, fill: 'forwards' })
    const handle = renderer.prepare({ source, movement, effects: [], duration, easing, dx: 300, dy: 0 })
    if (handle) await handle.finished
    await movement.finished
    const surface = document.querySelector('.discard-motion-surface')
    const intervals = JSON.parse(surface?.dataset.intervals || '[]')
    const span = intervals.reduce((sum, interval) => sum + interval.span, 0)
    if (handle && (intervals.length < 2 || Math.abs(span - 300 * devicePixelRatio) > 1e-5)) throw Error('Compiled worker did not submit the exact full trajectory')
    if (source.style.opacity !== '0.8' || source.style.getPropertyPriority('opacity') !== 'important') throw Error('Compiled motion lost the original source style')
    return { protocol: location.protocol, sourceProtocol: new URL(image.src).protocol, fallback: !handle,
      duration, submitted: intervals.length, span, pixelRatio: devicePixelRatio, failure: surface?.dataset.failure || null }
  } finally { renderer.stop(); movement?.cancel() }
}

boot().then(result => { window.compiledMotionResult = result }, error => {
  window.compiledMotionResult = { error: String(error) }
}).finally(() => { document.body.dataset.completed = 'true' })
