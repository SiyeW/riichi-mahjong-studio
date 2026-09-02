export const ANALYSIS_TILE_ROWS = [
  ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m'],
  ['1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p'],
  ['1s', '2s', '3s', '4s', '5s', '6s', '7s', '8s', '9s'],
  ['E', 'S', 'W', 'N', 'P', 'F', 'C'],
] as const

export const RED_FIVE_TILES = ['5mr', '5pr', '5sr'] as const

const SUIT_OFFSETS: Readonly<Record<string, number>> = {
  m: 0,
  p: 9,
  s: 18,
}

const HONOR_INDEXES: Readonly<Record<string, number>> = {
  E: 27,
  S: 28,
  W: 29,
  N: 30,
  P: 31,
  F: 32,
  C: 33,
}

export function isRedFiveTile(tile: string): boolean {
  return RED_FIVE_TILES.includes(tile as typeof RED_FIVE_TILES[number])
}

export function tile34Index(tile: string): number {
  const normalized = tile.replace('r', '')
  const honorIndex = HONOR_INDEXES[normalized]
  if (honorIndex !== undefined) return honorIndex

  const suit = normalized.slice(-1)
  const rank = Number.parseInt(normalized, 10)
  const offset = SUIT_OFFSETS[suit]
  if (offset === undefined || rank < 1 || rank > 9) return 0
  return offset + rank - 1
}

export function analysisCountTileRows(includeRedFives: boolean) {
  return ANALYSIS_TILE_ROWS.map((row, index) => ({
    key: ['m', 'p', 's', 'z'][index],
    tiles: index < RED_FIVE_TILES.length && includeRedFives
      ? [...row, RED_FIVE_TILES[index]]
      : [...row],
  }))
}

export function analysisCountSourceTiles(includeRedFives: boolean) {
  const ordinary = ANALYSIS_TILE_ROWS.flatMap((row, rowIndex) => row.map((tile, tileIndex) => ({
    tile,
    groupStart: rowIndex > 0 && tileIndex === 0,
  })))
  if (!includeRedFives) return ordinary
  return [
    ...ordinary,
    ...RED_FIVE_TILES.map((tile, index) => ({ tile, groupStart: index === 0 })),
  ]
}
