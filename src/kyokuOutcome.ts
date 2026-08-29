export type KyokuOutcome =
  | { type: 'draw'; probability: number }
  | { type: 'tsumo'; winner: number; probability: number }
  | { type: 'ron'; winners: number[]; target: number; probability: number }

export type KyokuOutcomePlayer = {
  seat: number
  winProbability: number
  dealInProbability: number
  winTargets: Array<{ seat: number; probability: number }>
  dealInWinnerSets: Array<{ winners: number[]; probability: number }>
}

export type ResolvedKyokuOutcome = {
  drawProbability: number
  players: KyokuOutcomePlayer[]
  hasDetails: boolean
  hasTotals: boolean
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {}
}

function seat(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isInteger(numeric) && numeric >= 0 && numeric < 4 ? numeric : null
}

function probability(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 1 ? numeric : null
}

export function parseKyokuOutcomes(value: unknown): KyokuOutcome[] {
  if (!Array.isArray(value)) return []
  const parsed: KyokuOutcome[] = []
  for (const rawValue of value) {
    const raw = record(rawValue)
    const outcomeProbability = probability(raw.probability)
    if (outcomeProbability === null) continue
    if (raw.type === 'draw') {
      parsed.push({ type: 'draw', probability: outcomeProbability })
      continue
    }
    if (raw.type === 'tsumo') {
      const winner = seat(raw.winner)
      if (winner !== null) parsed.push({ type: 'tsumo', winner, probability: outcomeProbability })
      continue
    }
    if (raw.type !== 'ron' || !Array.isArray(raw.winners)) continue
    const target = seat(raw.target)
    const winners = raw.winners.map(seat)
    if (
      target === null
      || winners.length < 1
      || winners.some((winner) => winner === null || winner === target)
      || new Set(winners).size !== winners.length
    ) continue
    parsed.push({
      type: 'ron',
      winners: winners as number[],
      target,
      probability: outcomeProbability,
    })
  }
  const total = parsed.reduce((sum, outcome) => sum + outcome.probability, 0)
  return total > 0
    ? parsed.map((outcome) => ({ ...outcome, probability: outcome.probability / total }))
    : []
}

function conditionalRows<T extends { probability: number }>(rows: T[]): T[] {
  const total = rows.reduce((sum, row) => sum + row.probability, 0)
  return total > 0 ? rows.map((row) => ({ ...row, probability: row.probability / total })) : []
}

export function resolveKyokuOutcome(value: unknown): ResolvedKyokuOutcome {
  const data = record(value)
  const outcomes = parseKyokuOutcomes(data.outcomes)
  const derivedPlayers = Array.from({ length: 4 }, (_, playerSeat): KyokuOutcomePlayer => ({
    seat: playerSeat,
    winProbability: 0,
    dealInProbability: 0,
    winTargets: [],
    dealInWinnerSets: [],
  }))
  let derivedDraw = 0

  for (const outcome of outcomes) {
    if (outcome.type === 'draw') {
      derivedDraw += outcome.probability
      continue
    }
    if (outcome.type === 'tsumo') {
      const player = derivedPlayers[outcome.winner]
      player.winProbability += outcome.probability
      player.winTargets.push({ seat: outcome.winner, probability: outcome.probability })
      continue
    }
    const target = derivedPlayers[outcome.target]
    target.dealInProbability += outcome.probability
    target.dealInWinnerSets.push({ winners: outcome.winners, probability: outcome.probability })
    for (const winner of outcome.winners) {
      const player = derivedPlayers[winner]
      player.winProbability += outcome.probability
      player.winTargets.push({ seat: outcome.target, probability: outcome.probability })
    }
  }

  for (const player of derivedPlayers) {
    const targetProbabilities = new Map<number, number>()
    for (const row of player.winTargets) {
      targetProbabilities.set(row.seat, (targetProbabilities.get(row.seat) || 0) + row.probability)
    }
    player.winTargets = conditionalRows([...targetProbabilities].map(([targetSeat, targetProbability]) => ({
      seat: targetSeat,
      probability: targetProbability,
    })))
    player.dealInWinnerSets = conditionalRows(player.dealInWinnerSets)
  }

  const directPlayers = Array.isArray(data.players) ? data.players.map(record) : []
  const directDraw = probability(data.drawProbability)
  const hasDirectSummary = directDraw !== null && [0, 1, 2, 3].every((playerSeat) => {
    const direct = directPlayers.find((player) => seat(player.seat) === playerSeat)
    return probability(direct?.winProbability) !== null
      && probability(direct?.dealInProbability) !== null
  })
  return {
    drawProbability: directDraw ?? derivedDraw,
    players: derivedPlayers.map((derived) => {
      const direct = directPlayers.find((player) => seat(player.seat) === derived.seat)
      return {
        ...derived,
        winProbability: probability(direct?.winProbability) ?? derived.winProbability,
        dealInProbability: probability(direct?.dealInProbability) ?? derived.dealInProbability,
      }
    }),
    hasDetails: outcomes.length > 0,
    hasTotals: hasDirectSummary || outcomes.length > 0,
  }
}
