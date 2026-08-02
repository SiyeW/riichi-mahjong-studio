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
