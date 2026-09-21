export type ScoreModeGeometryInput = Readonly<{
  availableWidth: number
  minimumItemWidth: number
  desiredGap: number
  maximumCount: number
  pixelRatio: number
}>

export type ScoreModeGeometry = Readonly<{
  count: number
  gap: number
  columns: readonly number[]
}>

export function scoreModeGeometry(input: ScoreModeGeometryInput): ScoreModeGeometry {
  const ratio = Math.max(1, input.pixelRatio || 1)
  const available = Math.max(1, Math.floor(input.availableWidth * ratio))
  const minimumItem = Math.max(1, Math.ceil(input.minimumItemWidth * ratio))
  const gap = input.desiredGap > 0
    ? Math.max(1, Math.round(input.desiredGap * ratio))
    : 0
  const maximumCount = Math.max(0, Math.floor(input.maximumCount))
  if (!maximumCount) return { count: 0, gap: gap / ratio, columns: [] }

  let count = maximumCount
  while (count > 1 && (minimumItem * count) + (gap * (count - 1)) > available) count -= 1
  const contentWidth = Math.max(count, available - (gap * Math.max(0, count - 1)))
  const baseColumnWidth = Math.floor(contentWidth / count)
  const remainder = contentWidth - (baseColumnWidth * count)
  const columns = Array.from({ length: count }, (_, index) => (
    (baseColumnWidth + (index < remainder ? 1 : 0)) / ratio
  ))
  return { count, gap: gap / ratio, columns }
}
