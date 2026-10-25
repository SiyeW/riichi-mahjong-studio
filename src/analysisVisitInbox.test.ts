import assert from 'node:assert/strict'
import test from 'node:test'
import { createAnalysisVisitInbox } from './analysisVisitInbox.ts'
import type { AnalysisViewToken } from './contracts/game.ts'

const token = (sequence: number, nodeId = 'A', intent = sequence): AnalysisViewToken => ({
  sessionId: 'session', sequence, intent, gameId: 'game', nodeId, seat: 0,
  mode: 'research', visibleHands: false, decisionEpoch: 1, opponentEpoch: 2,
})

test('both early analysis kinds wait for the exact table commit', () => {
  const inbox = createAnalysisVisitInbox(), applied: string[] = []
  inbox.commit(token(1))
  inbox.expect(2, 'B')
  inbox.receive('opponent', token(2, 'B'), () => applied.push('opponent'))
  inbox.receive('decision', token(2, 'B'), () => applied.push('decision'))
  assert.deepEqual(applied, [])
  inbox.commit(token(2, 'B'))
  assert.deepEqual(applied, ['opponent', 'decision'])
})

test('ABA visits and a newer wheel target never accept an obsolete result', () => {
  const inbox = createAnalysisVisitInbox(), applied: string[] = []
  inbox.commit(token(1))
  inbox.expect(2, 'B')
  inbox.receive('opponent', token(2, 'B'), () => applied.push('B'))
  inbox.expect(3, 'A')
  inbox.receive('opponent', token(1), () => applied.push('old A'))
  inbox.receive('decision', token(2, 'B'), () => applied.push('late B'))
  inbox.receive('opponent', token(3), () => applied.push('new A'))
  inbox.commit(token(3))
  assert.deepEqual(applied, ['new A'])
})

test('an intermediate wheel table preserves the newer pending analysis delivery', () => {
  const inbox = createAnalysisVisitInbox(), applied: string[] = []
  inbox.commit(token(1))
  inbox.expect(3, 'C')
  inbox.receive('opponent', token(3, 'C'), () => applied.push('C'))
  inbox.commit(token(2, 'B'))
  inbox.receive('opponent', token(2, 'B'), () => applied.push('late B'))
  assert.deepEqual(applied, [])
  inbox.commit(token(3, 'C'))
  assert.deepEqual(applied, ['C'])
})

test('only the latest early delivery per kind is retained; new sessions invalidate it', () => {
  const inbox = createAnalysisVisitInbox(), applied: number[] = []
  inbox.commit(token(1))
  for (let i = 2; i < 1000; ++i) inbox.receive('opponent', token(i), () => applied.push(i))
  inbox.commit(token(999))
  assert.deepEqual(applied, [999])
  inbox.invalidate()
  inbox.receive('decision', token(999), () => applied.push(-1))
  inbox.commit({ ...token(1), sessionId: 'reopened' })
  inbox.receive('decision', token(999), () => applied.push(-2))
  assert.deepEqual(applied, [999])
})

test('a same-sequence delivery with different input permissions cannot display', () => {
  const inbox = createAnalysisVisitInbox()
  inbox.commit(token(1))
  const forbidden = () => assert.fail('wrong input context displayed')
  inbox.receive('opponent', { ...token(1), visibleHands: true }, forbidden)
  inbox.receive('decision', { ...token(1), decisionEpoch: 3 }, forbidden)
  inbox.commit(token(1))
})

test('opening a new record buffers its early result, while a cancelled open keeps the old visit', () => {
  const inbox = createAnalysisVisitInbox(), applied: string[] = []
  inbox.commit(token(9))
  inbox.expectReplacement()
  inbox.receive('opponent', token(9), () => applied.push('old while opening'))
  const reopened = { ...token(1), sessionId: 'new-session' }
  inbox.receive('opponent', reopened, () => applied.push('new record'))
  inbox.commit(reopened)
  assert.deepEqual(applied, ['new record'])
  inbox.expectReplacement()
  inbox.commit(reopened)
  inbox.receive('decision', reopened, () => applied.push('cancelled open'))
  assert.deepEqual(applied, ['new record', 'cancelled open'])
})
