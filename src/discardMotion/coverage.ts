import { captureMotionSnapshot } from './snapshot'
import type { MotionReply, MotionRequest } from './messages'

export interface DiscardCoverage { readonly waiting: boolean; cancel(): void; finished: Promise<void> }
interface FlightOptions { source: HTMLElement; effects: Animation[]; movement: Animation; duration: number; easing: string; dx: number; dy: number }

/** One enabled-trial owner, one outstanding preparation, one worker surface. */
export function createDiscardCoverageRenderer() {
  let worker: Worker | null = null, canvas: HTMLCanvasElement | null = null, warm = false, sequence = 0
  let active: { id: number; ready(preparationMs: number): void; retire(): void } | null = null
  let snapshotBusy = false
  const post = (message: MotionRequest, transfer: Transferable[] = []) => worker?.postMessage(message, transfer)

  function stop() {
    active?.retire(); active = null
    worker?.terminate(); worker = null
    canvas?.remove(); canvas = null; warm = false
  }

  function start() {
    if (worker || document.hidden || !('OffscreenCanvas' in window) || typeof Worker !== 'function') return
    try {
      canvas = document.createElement('canvas')
      canvas.className = 'discard-motion-surface'
      canvas.setAttribute('aria-hidden', 'true'); canvas.inert = true
      canvas.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none;z-index:1000'
      document.body.append(canvas)
      worker = new Worker(new URL('./renderer.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<MotionReply>) => {
        const message = event.data
        if (message.type === 'warm') { warm = true; canvas!.dataset.ready = 'true'; return }
        if (message.type === 'failed' && message.id === 0) { stop(); return }
        if (!active || message.id !== active.id) return
        if (message.type === 'ready') active.ready(message.preparationMs)
        else {
          if (message.type === 'done') canvas!.dataset.intervals = JSON.stringify(message.intervals)
          else canvas!.dataset.failure = message.reason
          active.retire(); active = null
        }
      }
      worker.onerror = () => stop()
      const surface = canvas.transferControlToOffscreen()
      post({ type: 'init', canvas: surface }, [surface])
    } catch { stop() }
  }

  function prepare(options: FlightOptions): DiscardCoverage | null {
    if (!warm || !worker || !canvas || active || snapshotBusy || document.hidden || !options.source.isConnected) return null
    const { source, effects, movement, duration, easing, dx, dy } = options
    const id = ++sequence, surface = canvas, began = performance.now(), dpr = devicePixelRatio
    const oldOpacity = source.style.getPropertyValue('opacity'), oldPriority = source.style.getPropertyPriority('opacity')
    const animations = [movement, ...effects]
    animations.forEach(animation => { animation.pause(); animation.currentTime = 0 })
    let waiting = true, playing = false, resolve!: () => void
    const finished = new Promise<void>(done => { resolve = done })
    const fail = (reason: unknown) => { surface.dataset.failure = String(reason); retire() }
    delete surface.dataset.failure
    let watchdog = window.setTimeout(() => fail('Preparation timeout'), 120)
    const resizeObserver = new ResizeObserver(() => {
      if (!source.isConnected || devicePixelRatio !== dpr) fail('Source retired or DPI changed')
      else {
        const now = source.getBoundingClientRect()
        if (Math.abs(now.width - sourceRect.width) > .1 || Math.abs(now.height - sourceRect.height) > .1) fail('Source geometry changed')
      }
    })
    const sourceRect = source.getBoundingClientRect()
    const visible = () => { if (document.hidden) retire() }
    function retire() {
      if (!waiting) return
      waiting = false
      clearTimeout(watchdog); resizeObserver.disconnect()
      window.removeEventListener('resize', retire)
      document.removeEventListener('pointerdown', retire, true)
      document.removeEventListener('visibilitychange', visible)
      if (active?.id === id) {
        post({ type: 'cancel', id }); active = null
        surface.style.visibility = 'hidden'; delete surface.dataset.active
        surface.classList.remove('discard-flight-coverage')
      }
      if (oldOpacity) source.style.setProperty('opacity', oldOpacity, oldPriority)
      else source.style.removeProperty('opacity')
      // Preparation fallback starts the untouched native timeline. Active-flight
      // fallback merely reveals it at its actual current pose, never restarts.
      if (!playing) {
        const now = performance.now()
        animations.forEach(animation => { animation.play(); animation.startTime = now })
      }
      resolve()
    }
    active = { id, retire, ready(workerMs) {
      if (!waiting || !source.isConnected || document.hidden || devicePixelRatio !== dpr) { retire(); return }
      clearTimeout(watchdog); watchdog = window.setTimeout(() => fail('Playback timeout'), duration + 600)
      playing = true
      const startTime = performance.now()
      surface.dataset.active = String(id)
      surface.classList.add('discard-flight-coverage')
      surface.dataset.startTime = String(startTime)
      surface.dataset.admissionMs = String(startTime - began)
      surface.dataset.workerPreparationMs = String(workerMs)
      source.style.setProperty('opacity', '0', 'important')
      surface.style.visibility = 'visible'
      animations.forEach(animation => { animation.play(); animation.startTime = startTime })
      post({ type: 'start', id, absoluteTime: performance.timeOrigin + startTime })
    } }
    window.addEventListener('resize', retire)
    document.addEventListener('pointerdown', retire, true)
    document.addEventListener('visibilitychange', visible)
    resizeObserver.observe(source)
    snapshotBusy = true
    void captureMotionSnapshot(source, effects, dx, dy).then(snapshot => {
      if (!waiting || active?.id !== id) { snapshot.planes.forEach(bitmap => bitmap.close()); return }
      Object.assign(surface.style, { left: `${snapshot.left}px`, top: `${snapshot.top}px`,
        width: `${snapshot.geometry.width / snapshot.dpr}px`, height: `${snapshot.geometry.height / snapshot.dpr}px` })
      post({ type: 'prepare', id, geometry: snapshot.geometry, planes: snapshot.planes, mode: snapshot.mode,
        stops: snapshot.stops, duration, easing }, snapshot.planes)
    }, fail).finally(() => { snapshotBusy = false })
    return { get waiting() { return waiting }, cancel: retire, finished }
  }
  return { start, stop, prepare, get ready() { return warm } }
}
