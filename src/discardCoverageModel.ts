import type { UiMotionEasingFunction } from './uiMotion'

export interface CoveragePlan {
  exposure: number
  duration: number
  count: number
  maximumSpan: number
}

// Bound both preparation and temporary compositor surfaces. Unsupported demand
// falls back to the existing sharp flight instead of silently cutting its sweep.
export function planDiscardCoverage(duration: number, exposure: number, distance: number,
  tileExtent: number, ease: UiMotionEasingFunction): CoveragePlan | null {
  if (![duration, exposure, distance, tileExtent].every(Number.isFinite)
    || duration <= 0 || exposure <= 0 || distance < 1 || tileExtent < 1) return null
  exposure = Math.min(exposure, duration)
  const total = duration + exposure
  const times = [...new Set([0, exposure, duration, total,
    ...Array.from({ length: 127 }, (_, i) => total * (i + 1) / 128)])].sort((a, b) => a - b)
  const progress = (time: number) => ease(Math.max(0, Math.min(1, time / duration)))
  const spans = times.map(time => progress(time) - progress(time - exposure))
  const maximumSpan = Math.max(...spans)
  const needed = 1 + Math.ceil(maximumSpan * distance / (tileExtent / 4))
  const count = Math.max(8, 2 ** Math.ceil(Math.log2(needed)))
  if (count > 64) return null
  return { exposure, duration: total, count, maximumSpan }
}

export function flightTranslationFrames(from: string, to: string, duration: number,
  total: number, easing: string): Keyframe[] {
  return total > duration
    ? [{ transform: from, offset: 0, easing },
      { transform: to, offset: duration / total }, { transform: to, offset: 1 }]
    : [{ transform: from }, { transform: to }]
}
