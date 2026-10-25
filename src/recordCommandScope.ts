import type { GameView, RecordCommandScope } from './contracts/game'

/** Capture when the edit/action is authored, not when a delayed queue sends it. */
export function recordCommandScope(view: GameView): RecordCommandScope | undefined {
  const token = view.viewToken
  if (!token) return undefined
  return { sessionId: token.sessionId, nodeId: token.nodeId, seat: token.seat,
    mode: token.mode, intent: token.intent }
}
