import { parseCssEasing } from './motionCurve.ts'
export { parseCssEasing } from './motionCurve.ts'
export type { UiMotionEasingFunction } from './motionCurve.ts'

const UI_MOTION_DURATION_FALLBACK_MS = 110
const UI_MOTION_EASING_FALLBACK = 'cubic-bezier(0.33, 1, 0.68, 1)'

let motionTokens: { duration: number; easing: string } | null = null
let motionObserver: MutationObserver | null = null

function readMotionTokens() {
  if (motionTokens) return motionTokens
  if (typeof document === 'undefined' || !document.body) {
    return { duration: UI_MOTION_DURATION_FALLBACK_MS, easing: UI_MOTION_EASING_FALLBACK }
  }
  if (!motionObserver) {
    motionObserver = new MutationObserver(() => { motionTokens = null })
    for (const element of [document.documentElement, document.body]) {
      motionObserver.observe(element, { attributes: true, attributeFilter: ['style', 'class'] })
    }
    motionObserver.observe(document.head, { subtree: true, childList: true, characterData: true })
  }
  // Snapshot shared constants once, rather than forcing style resolution after
  // each individual chart has changed the DOM during the same frame.
  const style = getComputedStyle(document.body)
  motionTokens = {
    duration: parseCssTimeMs(style.getPropertyValue('--ui-motion-duration')) ?? UI_MOTION_DURATION_FALLBACK_MS,
    easing: style.getPropertyValue('--ui-motion-easing').trim() || UI_MOTION_EASING_FALLBACK,
  }
  return motionTokens
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  motionObserver?.disconnect()
  motionObserver = null
  motionTokens = null
})

export function parseCssTimeMs(value: string): number | null {
  const match = value.trim().toLowerCase().match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))(ms|s)$/)
  if (!match) return null

  const duration = Number(match[1])
  if (!Number.isFinite(duration) || duration < 0) return null
  return match[2] === 's' ? duration * 1000 : duration
}

export function getUiMotionDurationMs(): number {
  return readMotionTokens().duration
}

export function getUiMotionEasing(): string {
  return readMotionTokens().easing
}

export function getUiMotionEasingFunction() {
  return parseCssEasing(getUiMotionEasing())
    ?? parseCssEasing(UI_MOTION_EASING_FALLBACK)
    ?? ((progress: number) => Math.max(0, Math.min(1, progress)))
}
