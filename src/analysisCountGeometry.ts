export type GroupedCountGeometryInput = Readonly<{
  availableWidth: number
  availableHeight: number
  pixelRatio: number
  toggleHeight: number
  legendHeight: number
  minimumTileWidth: number
  maximumTileWidth?: number
  rowCount?: number
  longestRow?: number
  laneCount?: number
  tileGap?: number
}>

export type GroupedCountGeometry = Readonly<{
  tileWidth: number
  tileHeight: number
  chartGap: number
  gridGap: number
  barMinimumHeight: number
  rowMinimumHeight: number
  gridMinimumHeight: number
  mainRowWidth: number
}>

const TILE_ASPECT_RATIO = 3.18 / 2.45
const CHART_GAP_RATIO = 0.035
const GRID_GAP_RATIO = 0.1

export function groupedCountGeometry(input: GroupedCountGeometryInput): GroupedCountGeometry {
  const ratio = Math.max(1, input.pixelRatio || 1)
  const rowCount = Math.max(1, Math.floor(input.rowCount || 4))
  const longestRow = Math.max(1, Math.floor(input.longestRow || 9))
  const laneCount = Math.max(1, Math.floor(input.laneCount || 4))
  const availableWidth = Math.max(1, Math.floor(input.availableWidth * ratio))
  const availableHeight = Math.max(1, Math.floor(input.availableHeight * ratio))
  const toggleHeight = Math.max(0, Math.round(input.toggleHeight * ratio))
  const legendHeight = Math.max(0, Math.round(input.legendHeight * ratio))
  const tileGap = Math.max(0, Math.round((input.tileGap || 0) * ratio))
  const minimumTile = Math.max(laneCount, Math.round(input.minimumTileWidth * ratio))
  const maximumTile = Number.isFinite(input.maximumTileWidth)
    ? Math.max(minimumTile, Math.round((input.maximumTileWidth || 0) * ratio))
    : Number.POSITIVE_INFINITY
  const widthLimitedTile = Math.floor(
    (availableWidth - (tileGap * Math.max(0, longestRow - 1))) / longestRow,
  )
  // At the preferred size, the bar above a tile receives one full tile height.
  const heightCoefficient = rowCount * (
    (TILE_ASPECT_RATIO * 2) + CHART_GAP_RATIO + GRID_GAP_RATIO
  )
  const heightLimitedTile = Math.floor((availableHeight - toggleHeight) / heightCoefficient)
  const tile = Math.max(minimumTile, Math.min(widthLimitedTile, heightLimitedTile, maximumTile))
  const tileHeight = Math.max(1, Math.round(tile * TILE_ASPECT_RATIO))
  const chartGap = Math.max(1, Math.round(tile * CHART_GAP_RATIO))
  const gridGap = Math.max(1, Math.round(tile * GRID_GAP_RATIO))
  const barMinimumHeight = tileHeight
  const rowMinimumHeight = Math.max(tileHeight + chartGap + barMinimumHeight, legendHeight)
  const gridMinimumHeight = toggleHeight + (rowMinimumHeight * rowCount) + (gridGap * rowCount)
  return {
    tileWidth: tile / ratio,
    tileHeight: tileHeight / ratio,
    chartGap: chartGap / ratio,
    gridGap: gridGap / ratio,
    barMinimumHeight: barMinimumHeight / ratio,
    rowMinimumHeight: rowMinimumHeight / ratio,
    gridMinimumHeight: gridMinimumHeight / ratio,
    mainRowWidth: ((tile * longestRow) + (tileGap * Math.max(0, longestRow - 1))) / ratio,
  }
}
