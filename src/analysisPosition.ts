export function decisionPositionKey(gameId: string | null | undefined, nodeId: string | null | undefined, seat: number): string | null {
  if (!gameId || !nodeId || !Number.isInteger(seat) || seat < 0 || seat > 3) return null
  return JSON.stringify([gameId, nodeId, seat])
}

export type ViewRequestContext = {
  gameId: string | null | undefined
  seat: number
  mode: string
  generation: number
  intent: number
}

export function sameViewRequestContext(before: ViewRequestContext, current: ViewRequestContext): boolean {
  return before.gameId === current.gameId && before.seat === current.seat
    && before.mode === current.mode && before.generation === current.generation
    && before.intent === current.intent
}
