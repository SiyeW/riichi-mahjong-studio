const assert = require('node:assert/strict')
const test = require('node:test')

const { normalizeWorkspaceLayout: normalizeMainWorkspaceLayout } = require('./settings')

test('main and renderer workspace setting normalizers remain equivalent', async () => {
  const { normalizeWorkspaceLayout: normalizeRendererWorkspaceLayout } = await import(
    '../../../src/workspace/settings.ts'
  )
  const fixtures = [
    undefined,
    null,
    false,
    42,
    '',
    [],
    {},
    {
      order: ['console', 'table', 'analysis'],
      analysisVisible: true,
      analysisPanels: { opponents: false, game: true, risk: true, counts: false },
      consoleVisible: false,
    },
    {
      layout: {
        type: 'split',
        direction: 'horizontal',
        children: [
          { type: 'item', id: 'table' },
          { type: 'item', id: 'analysis-game' },
        ],
        weights: [3, 1],
      },
      panelSizeFractionsVersion: 2,
      panelSizeFractions: {
        console: { horizontal: 0.01, vertical: 0.4 },
        'analysis-game': { horizontal: 0.99 },
        unknown: { vertical: 0.5 },
      },
    },
  ]

  for (const fixture of fixtures) {
    assert.deepEqual(
      normalizeMainWorkspaceLayout(fixture),
      normalizeRendererWorkspaceLayout(fixture),
      `workspace settings differ for ${JSON.stringify(fixture)}`,
    )
  }
})
