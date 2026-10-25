import { captureMotionSnapshot } from './snapshot'
import type { MotionReply, MotionRequest } from './messages'
import { prepareEmbeddedTileArtwork } from '../tiles/artworkCatalog'
import { createMotionAtlasCache } from './atlasCache'

export interface DiscardCoverage { readonly waiting: boolean; cancel(): void; finished: Promise<void> }
interface FlightOptions { source: HTMLElement; effects: Animation[]; movement: Animation; duration: number; easing: string; dx: number; dy: number }
const PREPARATION_BUDGET_MS = 120

/** One renderer owner, one outstanding preparation, one worker surface. */
export function createDiscardCoverageRenderer({ diagnostics = false }: { diagnostics?: boolean } = {}) {
  let worker: Worker | null = null, canvas: HTMLCanvasElement | null = null, warm = false, sequence = 0
  let active: { id: number; ready(preparationMs: number): void; retire(): void } | null = null
  let snapshotBusy = false
  const atlasCache = createMotionAtlasCache()
  const post = (message: MotionRequest, transfer: Transferable[] = []) => worker?.postMessage(message, transfer)

  function stop() {
    atlasCache.clear()
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
      const owner = worker, embeddedArtwork = prepareEmbeddedTileArtwork()
      // Observe rejection immediately; a failed asset never leaves an unhandled
      // Promise while the independent worker is warming its context.
      void embeddedArtwork.catch(() => { if (worker === owner) stop() })
      worker.onmessage = (event: MessageEvent<MotionReply>) => {
        if (worker !== owner) return
        const message = event.data
        if (message.type === 'warm') {
          void embeddedArtwork.then(() => {
            if (worker === owner && canvas) { warm = true; canvas.dataset.ready = 'true' }
          }, () => {})
          return
        }
        if (message.type === 'failed' && message.id === 0) { stop(); return }
        if (!active || message.id !== active.id) return
        if (message.type === 'ready') active.ready(message.preparationMs)
        else {
          if (message.type === 'done') {
            if (diagnostics && message.intervals) canvas!.dataset.intervals = JSON.stringify(message.intervals)
          } else canvas!.dataset.failure = message.reason
          active.retire(); active = null
        }
      }
      worker.onerror = () => { if (worker === owner) stop() }
      const surface = canvas.transferControlToOffscreen()
      post({ type: 'init', canvas: surface, diagnostics }, [surface])
    } catch { stop() }
  }

  function prepare(options: FlightOptions): DiscardCoverage | null {
    if (!warm || !worker || !canvas || active || snapshotBusy || document.hidden || !options.source.isConnected
      || !(options.duration > 0)) return null
    const { source, effects, movement, duration, easing, dx, dy } = options
    const id = ++sequence, surface = canvas, began = performance.now(), dpr = devicePixelRatio
    const oldOpacity = source.style.getPropertyValue('opacity'), oldPriority = source.style.getPropertyPriority('opacity')
    const animations = [movement, ...effects]
    animations.forEach(animation => { animation.pause(); animation.currentTime = 0 })
    let waiting = true, playing = false, resolve!: () => void
    const finished = new Promise<void>(done => { resolve = done })
    const fail = (reason: unknown) => {
      if (!waiting || active?.id !== id) return
      surface.dataset.failure = String(reason); retire()
    }
    delete surface.dataset.failure
    let watchdog = window.setTimeout(() => fail('Preparation timeout'), PREPARATION_BUDGET_MS)
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
      // An overdue timer may run after this message when the main thread was
      // blocked. Admission is governed by elapsed time, not callback ordering.
      if (performance.now() - began > PREPARATION_BUDGET_MS) { fail('Preparation timeout'); return }
      clearTimeout(watchdog); watchdog = window.setTimeout(() => fail('Playback timeout'), duration + 600)
      playing = true
      const startTime = performance.now()
      surface.dataset.active = String(id)
      surface.classList.add('discard-flight-coverage')
      if (diagnostics) {
        surface.dataset.startTime = String(startTime)
        surface.dataset.admissionMs = String(startTime - began)
        surface.dataset.workerPreparationMs = String(workerMs)
      }
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
    void captureMotionSnapshot(source, effects, dx, dy, atlasCache).then(snapshot => {
      if (!waiting || active?.id !== id) return
      if (performance.now() - began > PREPARATION_BUDGET_MS) { fail('Preparation timeout'); return }
      if (diagnostics) {
        surface.dataset.snapshotMs = String(performance.now() - began)
        surface.dataset.snapshotStages = JSON.stringify(snapshot.timings)
      }
      Object.assign(surface.style, { left: `${snapshot.left}px`, top: `${snapshot.top}px`,
        width: `${snapshot.geometry.width / snapshot.dpr}px`, height: `${snapshot.geometry.height / snapshot.dpr}px`, opacity: snapshot.opacity })
      post({ type: 'prepare', id, geometry: snapshot.geometry, pixels: snapshot.pixels, planeCount: snapshot.planeCount, mode: snapshot.mode,
        stops: snapshot.stops, duration, easing }, [snapshot.pixels.buffer as ArrayBuffer])
    }, fail).finally(() => { snapshotBusy = false })
    return { get waiting() { return waiting }, cancel: retire, finished }
  }
  return { start, stop, prepare, get ready() { return warm } }
}
