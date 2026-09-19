import type { TableState } from './contracts/game.ts'
import type { NumericPrediction } from './numericPrediction.ts'
import { ANALYSIS_TILE_ROWS, RED_FIVE_TILES, isRedFiveTile, tile34Index } from './analysisTiles.ts'

type TilePredictionMap = Map<string, NumericPrediction>

export type RandomTileCountBaseline = {
  opponents: Map<number, TilePredictionMap>
  wall: TilePredictionMap
}

const ORDINARY_TILES = ANALYSIS_TILE_ROWS.flat()

function combination(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  const smaller = Math.min(k, n - k)
  let result = 1
  for (let index = 1; index <= smaller; index += 1) {
    result *= (n - smaller + index) / index
  }
  return result
}

export function randomCountDistribution(
  remainingCopies: number,
  sourceCapacity: number,
  unknownTileCount: number,
  maximumValue = 4,
): NumericPrediction {
  if (
    remainingCopies < 0
    || sourceCapacity < 0
    || unknownTileCount < 0
    || remainingCopies > unknownTileCount
    || sourceCapacity > unknownTileCount
  ) return { distribution: [], scalarValue: null, scalarSource: null }

  const denominator = combination(unknownTileCount, sourceCapacity)
  if (!Number.isFinite(denominator) || denominator <= 0) {
    const onlyValue = remainingCopies === 0 || sourceCapacity === 0 ? 0 : null
    return onlyValue === null
      ? { distribution: [], scalarValue: null, scalarSource: null }
      : {
          distribution: Array.from({ length: maximumValue + 1 }, (_, value) => ({
            value,
            probability: value === onlyValue ? 1 : 0,
          })),
          scalarValue: onlyValue,
          scalarSource: 'distribution',
        }
  }

  const distribution = Array.from({ length: maximumValue + 1 }, (_, value) => ({
    value,
    probability: combination(remainingCopies, value)
      * combination(unknownTileCount - remainingCopies, sourceCapacity - value)
      / denominator,
  }))
  const total = distribution.reduce((sum, entry) => sum + entry.probability, 0)
  const normalized = total > 0
    ? distribution.map((entry) => ({ ...entry, probability: entry.probability / total }))
    : distribution
  return {
    distribution: normalized,
    scalarValue: unknownTileCount > 0 ? sourceCapacity * remainingCopies / unknownTileCount : 0,
    scalarSource: 'distribution',
  }
}

function visibleMeldTiles(meld: Record<string, unknown>): string[] {
  const type = typeof meld.type === 'string' ? meld.type : ''
  const consumed = Array.isArray(meld.consumed)
    ? meld.consumed.filter((tile): tile is string => typeof tile === 'string')
    : []
  const calledOrAddedTile = typeof meld.pai === 'string' ? meld.pai : ''

  // Called tiles remain in the discarder river in Studio snapshots. Only the
  // tiles supplied from the caller's hand are additional public information.
  if (type === 'kakan') {
    return [...consumed.slice(0, 2), ...(calledOrAddedTile ? [calledOrAddedTile] : [])]
  }
  return consumed
}

function knownTiles(table: TableState, controlledSeat: number): string[] {
  const pendingDiscard = table.pendingRiichiDiscard || table.pendingDiscard
  return [
    ...(table.hands[controlledSeat] || []),
    ...table.rivers.flat(),
    ...table.melds.flatMap((melds) => melds.flatMap(visibleMeldTiles)),
    ...table.doraIndicators,
    ...(pendingDiscard?.pai ? [pendingDiscard.pai] : []),
  ]
}

function predictionMap(
  ordinaryRemaining: readonly number[],
  redRemaining: readonly number[],
  capacity: number,
  unknownTileCount: number,
): TilePredictionMap {
  const result = new Map<string, NumericPrediction>()
  ORDINARY_TILES.forEach((tile, index) => {
    result.set(tile, randomCountDistribution(ordinaryRemaining[index], capacity, unknownTileCount))
  })
  RED_FIVE_TILES.forEach((tile, index) => {
    result.set(tile, randomCountDistribution(redRemaining[index], capacity, unknownTileCount, 1))
  })
  return result
}

export function buildRandomTileCountBaseline(
  table: TableState | null | undefined,
  controlledSeat: number,
): RandomTileCountBaseline | null {
  if (!table || controlledSeat < 0 || controlledSeat > 3) return null
  if (table.hands.length !== 4 || table.rivers.length !== 4 || table.melds.length !== 4) return null

  const ordinaryRemaining = Array.from({ length: 34 }, () => 4)
  const redRemaining = [1, 1, 1]
  for (const tile of knownTiles(table, controlledSeat)) {
    const index = tile34Index(tile)
    if (index === null || ordinaryRemaining[index] <= 0) return null
    ordinaryRemaining[index] -= 1
    if (isRedFiveTile(tile)) {
      const redIndex = RED_FIVE_TILES.indexOf(tile as typeof RED_FIVE_TILES[number])
      if (redIndex < 0 || redRemaining[redIndex] <= 0) return null
      redRemaining[redIndex] -= 1
    }
  }

  const unknownTileCount = ordinaryRemaining.reduce((sum, count) => sum + count, 0)
  const opponentSeats = [0, 1, 2, 3].filter((seat) => seat !== controlledSeat)
  const opponentCapacities = opponentSeats.map((seat) => table.hands[seat]?.length ?? -1)
  if (opponentCapacities.some((capacity) => capacity < 0)) return null
  const wallCapacity = unknownTileCount - opponentCapacities.reduce((sum, capacity) => sum + capacity, 0)
  if (wallCapacity < 0) return null

  return {
    opponents: new Map(opponentSeats.map((seat, index) => [
      seat,
      predictionMap(ordinaryRemaining, redRemaining, opponentCapacities[index], unknownTileCount),
    ])),
    wall: predictionMap(ordinaryRemaining, redRemaining, wallCapacity, unknownTileCount),
  }
}

export function randomBaselinePrediction(
  baseline: RandomTileCountBaseline,
  tile: string,
  seat: number | null,
): NumericPrediction {
  return (seat === null ? baseline.wall.get(tile) : baseline.opponents.get(seat)?.get(tile))
    ?? { distribution: [], scalarValue: null, scalarSource: null }
}
