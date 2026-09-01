export const KYOKU_DELTA_BASE_SCALE = 1000

export function symmetricDeltaScale(
  values: Array<number | null | undefined>,
  baseScale = KYOKU_DELTA_BASE_SCALE,
): number {
  return Math.max(
    baseScale,
    ...values.map((value) => (
      typeof value === 'number' && Number.isFinite(value) ? Math.abs(value) : 0
    )),
  )
}

export function deltaHalfWidthPercent(value: number | null, scale: number): number {
  if (value === null || !Number.isFinite(value)) return 0
  return Math.min(50, (Math.abs(value) / Math.max(1, scale)) * 50)
}
