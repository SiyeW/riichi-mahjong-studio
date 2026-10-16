export type UiMotionEasingFunction = (progress: number) => number

function clampProgress(progress: number): number {
  return Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0
}

function cubicBezierCoordinate(t: number, first: number, second: number): number {
  const inverse = 1 - t
  return 3 * inverse * inverse * t * first + 3 * inverse * t * t * second + t * t * t
}

export function parseCssEasing(value: string): UiMotionEasingFunction | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'linear') return clampProgress
  const match = normalized.match(/^cubic-bezier\(\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*,\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*\)$/)
  if (!match) return null
  const [x1, y1, x2, y2] = match.slice(1).map(Number)
  if (![x1, y1, x2, y2].every(Number.isFinite) || x1 < 0 || x1 > 1 || x2 < 0 || x2 > 1) return null
  return rawProgress => {
    const progress = clampProgress(rawProgress)
    if (progress === 0 || progress === 1) return progress
    let lower = 0, upper = 1
    for (let iteration = 0; iteration < 18; iteration++) {
      const midpoint = (lower + upper) / 2
      if (cubicBezierCoordinate(midpoint, x1, x2) < progress) lower = midpoint
      else upper = midpoint
    }
    return cubicBezierCoordinate((lower + upper) / 2, y1, y2)
  }
}
