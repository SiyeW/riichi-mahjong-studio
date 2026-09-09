const RED_FIVE_FAMILY = /^5([mps])r$/
const RED_FIVE_DISPLAY = /^0([mps])$/

export function normalizeTileFamily(tile: unknown): string {
  const value = String(tile || '')
  const redFive = value.match(RED_FIVE_FAMILY) || value.match(RED_FIVE_DISPLAY)
  return redFive ? `5${redFive[1]}` : value
}

export function toRedFiveDisplayTile(tile: string): string {
  const family = normalizeTileFamily(tile)
  return /^5[mps]$/.test(family) ? `0${family[1]}` : tile
}
