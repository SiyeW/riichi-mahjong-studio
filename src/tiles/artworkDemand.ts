import { fittedTableZoom, tableTileWidth } from '../tableGeometry.ts'

// Two generations can coexist briefly during an atomic source-map handoff.
export const ARTWORK_GENERATION_BYTES = 16 * 1024 * 1024
export const ARTWORK_SIZE_STEP = 16

export function artworkPixelWidth(input: {
  screenWidth: number
  screenHeight: number
  windowWidth: number
  windowHeight: number
  pixelRatio: number
  uiTileWidth: number
}): number {
  // screen dimensions are already CSS pixels. Do not apply OS scale twice.
  const width = Math.max(input.screenWidth, input.windowWidth)
  const height = Math.max(input.screenHeight, input.windowHeight)
  const tableWidth = tableTileWidth(fittedTableZoom(width, height))
  const demand = Math.max(tableWidth, input.uiTileWidth) * input.pixelRatio
  return Math.ceil(demand / ARTWORK_SIZE_STEP) * ARTWORK_SIZE_STEP
}

export function artworkGenerationBytes(width: number, assets: number): number {
  return width * Math.ceil(width * 4 / 3) * 4 * assets
}

export function artworkWidthFitsBudget(width: number, assets: number): boolean {
  return Number.isSafeInteger(width) && width > 0 && assets > 0
    && artworkGenerationBytes(width, assets) <= ARTWORK_GENERATION_BYTES
}

export function maximumArtworkPixelWidth(assets: number): number {
  let width = ARTWORK_SIZE_STEP
  while (artworkWidthFitsBudget(width + ARTWORK_SIZE_STEP, assets)) width += ARTWORK_SIZE_STEP
  return artworkWidthFitsBudget(width, assets) ? width : 0
}
