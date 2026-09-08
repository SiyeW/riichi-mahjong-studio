import assert from 'node:assert/strict'
import test from 'node:test'

import { buildNextMoveHints } from './useNextMoveHints.ts'

function node(
  id: string,
  action: TrainerAction | null,
  children: string[] = [],
  mainChildId: string | null = null,
): TrainerTreeNode {
  return {
    id,
    type: 'action',
    parentId: null,
    children,
    mainChildId,
    action,
    depth: 0,
    roundDepth: 0,
  } as TrainerTreeNode
}

test('next move hints distinguish main and side discards', () => {
  const nodes = new Map<string, TrainerTreeNode>([
    ['current', node('current', null, ['main', 'side'], 'main')],
    ['main', node('main', {
      type: 'dahai', actor: 0, pai: '5pr', tsumogiri: true,
    } as TrainerAction)],
    ['side', node('side', {
      type: 'dahai', actor: 0, pai: '5p', tsumogiri: false,
    } as TrainerAction)],
  ])

  assert.deepEqual(buildNextMoveHints(nodes, 'current', 0), [
    {
      type: 'dahai',
      childNodeId: 'main',
      isMainBranch: true,
      pai: '5pr',
      tsumogiri: true,
    },
    {
      type: 'dahai',
      childNodeId: 'side',
      isMainBranch: false,
      pai: '5p',
      tsumogiri: false,
    },
  ])
})

test('next move hints include only actions by the controlled seat', () => {
  const nodes = new Map<string, TrainerTreeNode>([
    ['current', node('current', null, ['own', 'other'], 'own')],
    ['own', node('own', {
      type: 'reach', actor: 2,
    } as TrainerAction)],
    ['other', node('other', {
      type: 'pon', actor: 1, consumed: ['1m', '1m'],
    } as TrainerAction)],
  ])

  assert.deepEqual(buildNextMoveHints(nodes, 'current', 2), [
    {
      type: 'special',
      childNodeId: 'own',
      isMainBranch: true,
      actionType: 'reach',
      actionVariant: 'declare',
      consumed: [],
    },
  ])
})
