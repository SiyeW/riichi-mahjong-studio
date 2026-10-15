// Shared by live fitting and the full-window artwork prewarm bound.
export function fittedTableZoom(width: number, height: number): number {
  return Math.max(0.1, Math.min(((3 * width) + 16) / 1978, (height + 7.04) / 720.5099))
}

export function tableTileWidth(zoom: number): number {
  return 34 * zoom
}
