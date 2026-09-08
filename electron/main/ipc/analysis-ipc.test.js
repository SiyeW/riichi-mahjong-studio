const assert = require('node:assert/strict')
const test = require('node:test')
const { registerAnalysisIpc } = require('./analysis-ipc')

function fixture(cleared = {}) {
  const handlers = new Map()
  let dirtyCalls = 0
  const environmentGateway = {
    setAnalysisVisibility: async (value) => ({ value }),
    getShanten: async () => 'shanten',
    getShantenMjai: async () => 'mjai',
    clearAnalysisCaches: async () => ({ cleared }),
    startAutoAnalysis: async () => 'started',
    cancelAutoAnalysis: async () => 'canceled',
  }
  registerAnalysisIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    environmentGateway,
    markRecordDirty: () => { dirtyCalls += 1 },
  })
  return { dirtyCalls: () => dirtyCalls, handlers }
}

test('analysis IPC registers the complete analysis channel boundary', () => {
  const { handlers } = fixture()
  assert.deepEqual([...handlers.keys()].sort(), [
    'analysis:auto-cancel',
    'analysis:auto-start',
    'analysis:visibility',
    'debug:clear-analysis-caches',
    'debug:shanten-mjai',
    'game:shanten',
  ])
})

test('analysis cache clearing marks the record only when persisted analysis changed', async () => {
  const unchanged = fixture({ mortalEntries: 0, opponentEntries: 0, comparisons: 0, pendingReview: false })
  await unchanged.handlers.get('debug:clear-analysis-caches')()
  assert.equal(unchanged.dirtyCalls(), 0)

  for (const cleared of [
    { mortalEntries: 1 },
    { opponentEntries: 1 },
    { comparisons: 1 },
    { pendingReview: true },
  ]) {
    const changed = fixture(cleared)
    assert.deepEqual(await changed.handlers.get('debug:clear-analysis-caches')(), { cleared })
    assert.equal(changed.dirtyCalls(), 1)
  }
})
