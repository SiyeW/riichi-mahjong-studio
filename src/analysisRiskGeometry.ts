export type RiskGeometryInput = Readonly<{
  availableWidth: number
  availableHeight: number
  pixelRatio: number
  scaleSpace: number
  legendHeight: number
  minimumTileWidth?: number
  maximumTileWidth?: number
  rowCount?: number
  longestRow?: number
  laneCount?: number
}>

export type RiskGeometry = Readonly<{
  tileWidth: number
  tileHeight: number
  barsWidth: number
  barsHeight: number
  chartGap: number
  gridGap: number
  mainRowWidth: number
  scaleSpace: number
  rowMinimumHeight: number
  gridMinimumHeight: number
  gridContentHeight: number
}>

const TILE_ASPECT_RATIO = 3.18 / 2.45
const MINIMUM_BARS_TO_TILE_RATIO = 1
const PREFERRED_BARS_TO_TILE_RATIO = 1.14

export function analysisRiskGeometry(input: RiskGeometryInput): RiskGeometry {
  const ratio = Math.max(1, input.pixelRatio || 1)
  const rowCount = Math.max(1, Math.floor(input.rowCount || 4))
  const longestRow = Math.max(1, Math.floor(input.longestRow || 9))
  const laneCount = Math.max(1, Math.floor(input.laneCount || 3))
  const available = Math.max(1, Math.floor(input.availableWidth * ratio))
  const availableHeight = Math.max(1, Math.floor(input.availableHeight * ratio))
  const scale = Math.max(1, Math.round(input.scaleSpace * ratio))
  const minimumTile = Math.max(laneCount, Math.round((input.minimumTileWidth || laneCount) * ratio))
  const maximumTile = Number.isFinite(input.maximumTileWidth)
    ? Math.max(minimumTile, Math.round((input.maximumTileWidth || 0) * ratio))
    : Number.POSITIVE_INFINITY
  const widthLimitedTile = Math.floor((available - scale) / longestRow)
  const legendHeight = Math.max(0, Math.round(input.legendHeight * ratio))
  const preferredHeightCoefficient = rowCount * (
    (TILE_ASPECT_RATIO * (1 + PREFERRED_BARS_TO_TILE_RATIO))
    + 0.035
    + 0.1
  )
  const heightLimitedTile = Math.floor((availableHeight - legendHeight) / preferredHeightCoefficient)
  const tile = Math.max(minimumTile, Math.min(widthLimitedTile, heightLimitedTile, maximumTile))
  const tileHeight = Math.max(1, Math.round(tile * TILE_ASPECT_RATIO))
  const barsWidth = Math.max(laneCount, Math.round(tile * 0.84))
  const chartGap = Math.max(1, Math.round(tile * 0.035))
  const gridGap = Math.max(1, Math.round(tile * 0.1))
  const minimumBarsHeight = Math.max(1, Math.round(tileHeight * MINIMUM_BARS_TO_TILE_RATIO))
  const availableBarsHeight = Math.floor(
    (availableHeight - legendHeight - (gridGap * rowCount)) / rowCount,
  ) - tileHeight - chartGap
  const barsHeight = Math.max(minimumBarsHeight, availableBarsHeight)
  const rowMinimumHeight = tileHeight + chartGap + minimumBarsHeight
  const rowHeight = tileHeight + chartGap + barsHeight
  return {
    tileWidth: tile / ratio,
    tileHeight: tileHeight / ratio,
    barsWidth: barsWidth / ratio,
    barsHeight: barsHeight / ratio,
    chartGap: chartGap / ratio,
    gridGap: gridGap / ratio,
    mainRowWidth: (tile * longestRow) / ratio,
    scaleSpace: scale / ratio,
    rowMinimumHeight: rowMinimumHeight / ratio,
    gridMinimumHeight: (
      (rowMinimumHeight * rowCount)
      + (gridGap * rowCount)
      + legendHeight
    ) / ratio,
    gridContentHeight: (
      (rowHeight * rowCount)
      + (gridGap * rowCount)
      + legendHeight
    ) / ratio,
  }
}
