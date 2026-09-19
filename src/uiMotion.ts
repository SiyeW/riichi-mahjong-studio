const UI_MOTION_DURATION_FALLBACK_MS = 110
const UI_MOTION_EASING_FALLBACK = 'cubic-bezier(0.33, 1, 0.68, 1)'

function bodyStyle(): CSSStyleDeclaration | null {
  return typeof document === 'undefined' ? null : getComputedStyle(document.body)
}

export function parseCssTimeMs(value: string): number | null {
  const match = value.trim().toLowerCase().match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))(ms|s)$/)
  if (!match) return null

  const duration = Number(match[1])
  if (!Number.isFinite(duration) || duration < 0) return null
  return match[2] === 's' ? duration * 1000 : duration
}

export function getUiMotionDurationMs(): number {
  return parseCssTimeMs(bodyStyle()?.getPropertyValue('--ui-motion-duration') || '')
    ?? UI_MOTION_DURATION_FALLBACK_MS
}

export function getUiMotionEasing(): string {
  return bodyStyle()?.getPropertyValue('--ui-motion-easing').trim() || UI_MOTION_EASING_FALLBACK
}

export type UiMotionEasingFunction = (progress: number) => number

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0
  return Math.max(0, Math.min(1, progress))
}

function cubicBezierCoordinate(t: number, first: number, second: number): number {
  const inverse = 1 - t
  return (3 * inverse * inverse * t * first) + (3 * inverse * t * t * second) + (t * t * t)
}

export function parseCssEasing(value: string): UiMotionEasingFunction | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'linear') return clampProgress
  const match = normalized.match(/^cubic-bezier\(\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*\)$/)
  if (!match) return null
  const [, rawX1, rawY1, rawX2, rawY2] = match
  const [x1, y1, x2, y2] = [rawX1, rawY1, rawX2, rawY2].map(Number)
  if (![x1, y1, x2, y2].every(Number.isFinite) || x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return null
  return (rawProgress: number) => {
    const progress = clampProgress(rawProgress)
    if (progress === 0 || progress === 1) return progress
    let lower = 0
    let upper = 1
    for (let iteration = 0; iteration < 18; iteration += 1) {
      const midpoint = (lower + upper) / 2
      if (cubicBezierCoordinate(midpoint, x1, x2) < progress) lower = midpoint
      else upper = midpoint
    }
    return cubicBezierCoordinate((lower + upper) / 2, y1, y2)
  }
}

export function getUiMotionEasingFunction(): UiMotionEasingFunction {
  return parseCssEasing(getUiMotionEasing())
    ?? parseCssEasing(UI_MOTION_EASING_FALLBACK)
    ?? clampProgress
}
