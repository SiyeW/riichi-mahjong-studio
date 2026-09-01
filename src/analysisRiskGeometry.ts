export type RiskGeometryInput = Readonly<{
  availableWidth: number
  pixelRatio: number
  scaleSpace: number
  legendHeight: number
  rowCount?: number
  longestRow?: number
  laneCount?: number
}>

export type RiskGeometry = Readonly<{
  tileWidth: number
  tileHeight: number
  barsWidth: number
  chartGap: number
  gridGap: number
  mainRowWidth: number
  scaleSpace: number
  rowMinimumHeight: number
  gridMinimumHeight: number
}>

const TILE_ASPECT_RATIO = 3.18 / 2.45

export function analysisRiskGeometry(input: RiskGeometryInput): RiskGeometry {
  const ratio = Math.max(1, input.pixelRatio || 1)
  const rowCount = Math.max(1, Math.floor(input.rowCount || 4))
  const longestRow = Math.max(1, Math.floor(input.longestRow || 9))
  const laneCount = Math.max(1, Math.floor(input.laneCount || 3))
  const available = Math.max(1, Math.floor(input.availableWidth * ratio))
  const scale = Math.max(1, Math.round(input.scaleSpace * ratio))
  const tile = Math.max(laneCount, Math.floor((available - scale) / longestRow))
  const tileHeight = Math.max(1, Math.round(tile * TILE_ASPECT_RATIO))
  const barsWidth = Math.max(laneCount, Math.round(tile * 0.84))
  const chartGap = Math.max(1, Math.round(tile * 0.035))
  const gridGap = Math.max(1, Math.round(tile * 0.1))
  const legendHeight = Math.max(0, Math.round(input.legendHeight * ratio))
  const rowMinimumHeight = tileHeight + chartGap + tileHeight
  return {
    tileWidth: tile / ratio,
    tileHeight: tileHeight / ratio,
    barsWidth: barsWidth / ratio,
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
  }
}
