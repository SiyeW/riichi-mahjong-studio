import assert from 'node:assert/strict'
import test from 'node:test'
import { createDefaultDockLayout } from './workspaceLayout.ts'
import { normalizeDockPanelFraction, normalizeDockPanelSizeFractions, normalizeWorkspaceLayout } from './workspaceSettings.ts'

test('missing workspace settings retain the established defaults', () => {
  const expected = {
    layout: createDefaultDockLayout(),
    analysisVisible: false,
    analysisPanels: { opponents: true, game: true, risk: false, counts: false },
    consoleVisible: true,
    panelSizeFractionsVersion: 2,
    panelSizeFractions: {},
  }
  for (const value of [undefined, null, false, 42, '', [], {}]) {
    assert.deepEqual(normalizeWorkspaceLayout(value), expected)
  }
})

test('hidden analysis retains its individual panel choices', () => {
  const input = {
    analysisVisible: false,
    consoleVisible: false,
    analysisPanels: { opponents: false, game: true, risk: true, counts: false },
  }
  const hidden = normalizeWorkspaceLayout(input)
  const reopened = normalizeWorkspaceLayout({ ...hidden, analysisVisible: true })
  assert.deepEqual(reopened.analysisPanels, input.analysisPanels)
  assert.equal(reopened.consoleVisible, false)
  assert.equal(reopened.analysisVisible, true)
})

test('legacy panel order is migrated without reusing obsolete size fractions', () => {
  const order = ['console', 'table', 'analysis']
  for (const version of [undefined, 1, '2', 3]) {
    const result = normalizeWorkspaceLayout({
      order, panelSizeFractionsVersion: version,
      panelSizeFractions: { console: { horizontal: 0.7 } },
    })
    assert.deepEqual(result.layout, createDefaultDockLayout(order))
    assert.deepEqual(result.panelSizeFractions, {})
    assert.equal(result.panelSizeFractionsVersion, 2)
  }
})

test('remembered sizes keep horizontal and vertical dimensions independent', () => {
  const result = normalizeWorkspaceLayout({
    panelSizeFractionsVersion: 2,
    panelSizeFractions: {
      console: { horizontal: 0.22, vertical: 0.35 },
      'analysis-counts': { horizontal: 0.3 },
      'analysis-risk': { vertical: 0.4 },
    },
  })
  assert.deepEqual(result.panelSizeFractions, {
    console: { horizontal: 0.22, vertical: 0.35 },
    'analysis-counts': { horizontal: 0.3 },
    'analysis-risk': { vertical: 0.4 },
  })
  assert.deepEqual(normalizeWorkspaceLayout(result), result)
})

test('invalid remembered sizes are discarded and accepted sizes respect bounds', () => {
  for (const value of [undefined, null, '', 0, -1, 1, 2, NaN, Infinity, 'invalid']) {
    assert.equal(normalizeDockPanelFraction(value), null)
  }
  assert.equal(normalizeDockPanelFraction(0.01), 0.08)
  assert.equal(normalizeDockPanelFraction(0.99), 0.8)
  assert.equal(normalizeDockPanelFraction('0.25'), 0.25)
  assert.deepEqual(normalizeDockPanelSizeFractions({
    console: { horizontal: -1, vertical: 0.4, other: 0.3 },
    'analysis-game': { horizontal: 'invalid' },
    'analysis-risk': null,
    table: { horizontal: 0.5 },
    unknown: { vertical: 0.5 },
  }), { console: { vertical: 0.4 } })
})

test('normalizing a saved workspace neither mutates nor shares its mutable settings', () => {
  const input = normalizeWorkspaceLayout(null)
  input.panelSizeFractions.console = { horizontal: 0.2 }
  const snapshot = structuredClone(input)
  const result = normalizeWorkspaceLayout(input)
  assert.deepEqual(input, snapshot)
  result.analysisPanels.game = false
  result.panelSizeFractions.console!.horizontal = 0.6
  if (result.layout.type === 'split') result.layout.weights[0] = 99
  assert.deepEqual(input, snapshot)
})
