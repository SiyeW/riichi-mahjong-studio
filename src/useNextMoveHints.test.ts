import assert from 'node:assert/strict'
import test from 'node:test'

import { buildNextMoveHints } from './useNextMoveHints.ts'
import type { GameAction, GameTreeNode } from './contracts/game.ts'

function node(
  id: string,
  action: GameAction | null,
  children: string[] = [],
  mainChildId: string | null = null,
): GameTreeNode {
  return {
    id,
    type: 'action',
    parentId: null,
    children,
    mainChildId,
    action,
    depth: 0,
    roundDepth: 0,
  } as GameTreeNode
}

test('next move hints distinguish main and side discards', () => {
  const nodes = new Map<string, GameTreeNode>([
    ['current', node('current', null, ['main', 'side'], 'main')],
    ['main', node('main', {
      type: 'dahai', actor: 0, pai: '5pr', tsumogiri: true,
    } as GameAction)],
    ['side', node('side', {
      type: 'dahai', actor: 0, pai: '5p', tsumogiri: false,
    } as GameAction)],
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
  const nodes = new Map<string, GameTreeNode>([
    ['current', node('current', null, ['own', 'other'], 'own')],
    ['own', node('own', {
      type: 'reach', actor: 2,
    } as GameAction)],
    ['other', node('other', {
      type: 'pon', actor: 1, consumed: ['1m', '1m'],
    } as GameAction)],
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
