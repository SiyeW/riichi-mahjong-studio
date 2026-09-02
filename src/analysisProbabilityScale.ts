export const DEFAULT_PROBABILITY_SCALE = 0.2
export const DEFAULT_PROBABILITY_TICK_STEP = 0.05

export type ProbabilityScaleTick = Readonly<{
  value: number
  label: string
}>

export function clampProbability(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 0
  return Math.max(0, Math.min(1, numeric))
}

export function adaptiveProbabilityScale(
  values: Iterable<unknown>,
  minimum = DEFAULT_PROBABILITY_SCALE,
): number {
  let maximum = clampProbability(minimum)
  for (const value of values) maximum = Math.max(maximum, clampProbability(value))
  return maximum
}

export function probabilityScaleTicks(
  scale: number,
  step = DEFAULT_PROBABILITY_TICK_STEP,
): ProbabilityScaleTick[] {
  const safeScale = Math.max(0, clampProbability(scale))
  const safeStep = Math.max(Number.EPSILON, clampProbability(step))
  const stepCount = Math.floor((safeScale + Number.EPSILON) / safeStep)
  return Array.from({ length: stepCount + 1 }, (_, index) => ({
    value: index * safeStep,
    label: index % 2 === 0 ? `${Math.round(index * safeStep * 100)}%` : '',
  }))
}

export function probabilityScaleRatio(value: unknown, scale: number): number {
  const safeScale = Math.max(Number.EPSILON, clampProbability(scale))
  return Math.min(1, clampProbability(value) / safeScale)
}

export function probabilityScalePercent(value: unknown, scale: number): string {
  return `${(probabilityScaleRatio(value, scale) * 100).toFixed(1)}%`
}
