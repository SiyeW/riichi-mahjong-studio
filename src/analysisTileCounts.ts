import { RED_FIVE_TILES } from './analysisTiles.ts'

export { RED_FIVE_TILES } from './analysisTiles.ts'

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function containsRedFive(value: unknown): boolean {
  const redTiles = objectValue(objectValue(value).redTiles)
  return RED_FIVE_TILES.some((tile) => Object.prototype.hasOwnProperty.call(redTiles, tile))
}

export function hasRedFiveCountPredictions(
  wallOutput: unknown,
  opponentPlayers: unknown,
): boolean {
  if (containsRedFive(wallOutput)) return true
  return Array.isArray(opponentPlayers) && opponentPlayers.some(containsRedFive)
}
