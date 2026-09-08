import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveActionAnnouncementText } from './useActionAnnouncement.ts'

const t = (key: string) => key
const node = (action: Record<string, unknown> | null) => ({ action }) as TrainerTreeNode

test('action announcement labels calls and riichi', () => {
  assert.equal(resolveActionAnnouncementText(node({ type: 'reach' }), t), 'action.riichi')
  assert.equal(resolveActionAnnouncementText(node({ type: 'chi' }), t), 'action.chi')
  assert.equal(resolveActionAnnouncementText(node({ type: 'pon' }), t), 'action.pon')
  assert.equal(resolveActionAnnouncementText(node({ type: 'ankan' }), t), 'action.kan')
})

test('action announcement distinguishes ron from both forms of tsumo', () => {
  assert.equal(resolveActionAnnouncementText(node({ type: 'hora', actor: 1, target: 2 }), t), 'action.ronShort')
  assert.equal(resolveActionAnnouncementText(node({ type: 'hora', actor: 1, target: 1 }), t), 'action.tsumo')
  assert.equal(resolveActionAnnouncementText(node({ type: 'hora', actor: 1, target: 2, variant: 'tsumo' }), t), 'action.tsumo')
})

test('action announcement ignores nodes without an announced action', () => {
  assert.equal(resolveActionAnnouncementText(null, t), null)
  assert.equal(resolveActionAnnouncementText(node(null), t), null)
  assert.equal(resolveActionAnnouncementText(node({ type: 'dahai' }), t), null)
})
