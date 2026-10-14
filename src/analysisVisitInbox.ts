import type { AnalysisViewToken } from './contracts/game'

type Kind = 'decision' | 'opponent'
type Delivery = { token: AnalysisViewToken; apply: () => void }

export function sameAnalysisVisit(a: AnalysisViewToken, b: AnalysisViewToken): boolean {
  return a.sessionId === b.sessionId && a.sequence === b.sequence && a.intent === b.intent
    && a.gameId === b.gameId && a.nodeId === b.nodeId && a.seat === b.seat
    && a.mode === b.mode && a.visibleHands === b.visibleHands
    && a.decisionEpoch === b.decisionEpoch && a.opponentEpoch === b.opponentEpoch
}

/** At most one early result per kind. Data identity never grants display authority. */
export function createAnalysisVisitInbox() {
  let committed: AnalysisViewToken | null = null
  let expected: { intent: number; nodeId: string } | null = null
  let invalidated = false
  let replacing = false
  const early = new Map<Kind, Delivery>()

  function reset() {
    committed = expected = null
    invalidated = false
    replacing = false
    early.clear()
  }

  function expect(intent: number, nodeId: string) {
    expected = { intent, nodeId }
    invalidated = false
    replacing = false
    early.clear()
  }

  function receive(kind: Kind, token: AnalysisViewToken | null | undefined, apply: () => void) {
    if (!token || invalidated) return false
    if (replacing) {
      if (token.sessionId === committed?.sessionId) return false
      early.set(kind, { token, apply })
      return false
    }
    if (!committed || token.sessionId !== committed.sessionId) return false
    // The backend can normalize a requested hidden reaction node to its visible
    // cursor. The unique intent binds that response; its committed token supplies
    // the actual node. Requiring the unnormalized node would drop early results.
    if (expected && token.intent !== expected.intent) return false
    if (!expected && sameAnalysisVisit(token, committed)) {
      apply()
      return true
    }
    if (token.sequence <= committed.sequence) return false
    const previous = early.get(kind)
    if (!previous || previous.token.sequence <= token.sequence) early.set(kind, { token, apply })
    return false
  }

  function commit(token: AnalysisViewToken | null | undefined) {
    if (!token) { reset(); return }
    committed = token
    expected = null
    invalidated = false
    replacing = false
    const ready = [...early.values()].filter((item) => sameAnalysisVisit(item.token, token))
    early.clear()
    for (const item of ready) item.apply()
  }

  function invalidate() {
    invalidated = true
    replacing = false
    expected = null
    early.clear()
  }

  function expectReplacement() {
    early.clear()
    replacing = true
    invalidated = false
    expected = null
  }

  return { receive, commit, expect, expectReplacement, invalidate, reset }
}
