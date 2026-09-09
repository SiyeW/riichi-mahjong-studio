import assert from 'node:assert/strict'
import test from 'node:test'
import { effectScope, nextTick, reactive, ref } from 'vue'
import type { StudioSettings } from '../contracts/settings.ts'
import type { WorkspaceLayoutSettings } from '../contracts/workspace.ts'
import { normalizeWorkspaceLayout } from './settings.ts'
import { useWorkspaceSession } from './useWorkspaceSession.ts'

function settingsWith(layout = normalizeWorkspaceLayout(null)): StudioSettings {
  return reactive({
    display: { workspaceLayout: structuredClone(layout) },
  } as StudioSettings)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('workspace session owns panel visibility and preserves prior selections', () => {
  const settings = settingsWith()
  const scope = effectScope()
  const session = scope.run(() => useWorkspaceSession({
    settings,
    settingsDraft: settingsWith(),
    showSettingsPanel: ref(false),
    hasGameTable: ref(true),
    uiScale: ref(1),
    t: (key) => key,
    applySettings: () => {},
    scheduleTableZoomRecalc: () => {},
    saveWorkspaceLayout: () => undefined,
  }))!

  assert.equal(session.showAnalysisDock.value, false)
  session.toggleAnalysisDock()
  assert.equal(session.showAnalysisDock.value, true)
  assert.deepEqual(settings.display.workspaceLayout.analysisPanels, {
    opponents: true,
    game: true,
    risk: false,
    counts: false,
  })

  session.toggleAnalysisPanel('risk')
  session.toggleAnalysisDock()
  session.toggleAnalysisDock()
  assert.equal(settings.display.workspaceLayout.analysisPanels.risk, true)
  session.closeAnalysisPanel('analysis-risk')
  assert.equal(settings.display.workspaceLayout.analysisPanels.risk, false)
  scope.stop()
})

test('workspace session applies only the newest asynchronous save reply', async () => {
  const settings = settingsWith()
  const saves: Array<{
    layout: WorkspaceLayoutSettings
    pending: ReturnType<typeof deferred<StudioSettings>>
  }> = []
  const applied: StudioSettings[] = []
  const scope = effectScope()
  const session = scope.run(() => useWorkspaceSession({
    settings,
    settingsDraft: settingsWith(),
    showSettingsPanel: ref(false),
    hasGameTable: ref(true),
    uiScale: ref(1),
    t: (key) => key,
    applySettings: (saved) => { applied.push(saved) },
    scheduleTableZoomRecalc: () => {},
    saveWorkspaceLayout: (layout) => {
      const pending = deferred<StudioSettings>()
      saves.push({ layout, pending })
      return pending.promise
    },
  }))!

  session.toggleConsoleDock()
  session.toggleConsoleDock()
  assert.equal(saves.length, 2)
  saves[1].pending.resolve(settingsWith(saves[1].layout))
  await nextTick()
  await new Promise((resolve) => setImmediate(resolve))
  saves[0].pending.resolve(settingsWith(saves[0].layout))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(applied.length, 1)
  assert.equal(applied[0].display.workspaceLayout.consoleVisible, true)
  scope.stop()
})
