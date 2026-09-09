import { computed, nextTick, type Ref } from 'vue'
import type { StudioSettings } from '../contracts/settings.ts'
import type {
  AnalysisPanelId,
  DockPanelId,
  WorkspaceItemId,
  WorkspaceLayoutSettings,
} from '../contracts/workspace.ts'
import { mergeSettingsReply } from '../settingsChanges.ts'
import { normalizeWorkspaceLayout } from './settings.ts'
import { useWorkspaceDock } from './useWorkspaceDock.ts'

export type AnalysisPanelKey = keyof WorkspaceLayoutSettings['analysisPanels']
export type AnalysisPanelSection = 'opponents' | 'game' | 'risk' | 'counts'

export const ANALYSIS_PANEL_DEFINITIONS: ReadonlyArray<{
  id: AnalysisPanelId
  key: AnalysisPanelKey
  section: AnalysisPanelSection
  labelKey: string
}> = [
  { id: 'analysis-opponents', key: 'opponents', section: 'opponents', labelKey: 'analysis.opponents' },
  { id: 'analysis-game', key: 'game', section: 'game', labelKey: 'analysis.players' },
  { id: 'analysis-risk', key: 'risk', section: 'risk', labelKey: 'analysis.riskPrediction' },
  { id: 'analysis-counts', key: 'counts', section: 'counts', labelKey: 'analysis.countPrediction' },
]

interface WorkspaceSessionOptions {
  settings: StudioSettings
  settingsDraft: StudioSettings
  showSettingsPanel: Readonly<Ref<boolean>>
  hasGameTable: Readonly<Ref<boolean>>
  uiScale: Readonly<Ref<number>>
  t: (key: string) => string
  applySettings: (settings: StudioSettings) => void
  scheduleTableZoomRecalc: () => void
  saveWorkspaceLayout: (layout: WorkspaceLayoutSettings) => Promise<StudioSettings> | undefined
}

export function useWorkspaceSession(options: WorkspaceSessionOptions) {
  const workspaceLayout = computed(() => normalizeWorkspaceLayout(options.settings.display.workspaceLayout))
  let saveGeneration = 0

  function applyLocally(nextLayout: WorkspaceLayoutSettings) {
    const normalized = normalizeWorkspaceLayout(nextLayout)
    options.settings.display.workspaceLayout = normalized
    if (options.showSettingsPanel.value) {
      options.settingsDraft.display.workspaceLayout = structuredClone(normalized)
    }
    void nextTick(options.scheduleTableZoomRecalc)
    return normalized
  }

  function update(nextLayout: WorkspaceLayoutSettings) {
    const normalized = applyLocally(nextLayout)
    const generation = ++saveGeneration
    const save = options.saveWorkspaceLayout(structuredClone(normalized))
    if (!save) return
    void save.then((saved) => {
      if (generation !== saveGeneration) return
      options.applySettings(mergeSettingsReply(
        options.settings,
        saved,
        { display: { workspaceLayout: normalized } },
      ))
    }).catch((error) => {
      console.warn('Failed to save workspace layout:', error)
    })
  }

  function analysisPanelDefinition(id: AnalysisPanelId) {
    return ANALYSIS_PANEL_DEFINITIONS.find((definition) => definition.id === id)
  }

  function isAnalysisPanelId(id: WorkspaceItemId): id is AnalysisPanelId {
    return id.startsWith('analysis-')
  }

  function analysisPanelSection(id: AnalysisPanelId): AnalysisPanelSection {
    return analysisPanelDefinition(id)?.section || 'opponents'
  }

  function analysisPanelTitle(id: AnalysisPanelId): string {
    return options.t(analysisPanelDefinition(id)?.labelKey || 'analysis.opponents')
  }

  function analysisPanelIsSelected(id: AnalysisPanelId): boolean {
    const definition = analysisPanelDefinition(id)
    return definition ? workspaceLayout.value.analysisPanels[definition.key] : false
  }

  const hasSelectedAnalysisPanels = computed(() => (
    ANALYSIS_PANEL_DEFINITIONS.some(({ key }) => workspaceLayout.value.analysisPanels[key])
  ))
  const showAnalysisDock = computed(() => (
    workspaceLayout.value.analysisVisible
    && hasSelectedAnalysisPanels.value
    && options.hasGameTable.value
  ))
  const showConsoleDock = computed(() => workspaceLayout.value.consoleVisible)

  function showAnalysisPanel(id: AnalysisPanelId): boolean {
    return showAnalysisDock.value && analysisPanelIsSelected(id)
  }

  const visiblePanels = computed<readonly DockPanelId[]>(() => [
    ...(showConsoleDock.value ? ['console' as const] : []),
    ...ANALYSIS_PANEL_DEFINITIONS.filter(({ id }) => showAnalysisPanel(id)).map(({ id }) => id),
  ])
  const dock = useWorkspaceDock({
    workspaceLayout,
    visiblePanels,
    uiScale: options.uiScale,
    applyWorkspaceLayoutLocally: applyLocally,
    updateWorkspaceLayout: update,
    invalidateLayoutSave: () => { saveGeneration += 1 },
  })

  const dockDropLabel = computed(() => options.t({
    left: 'workspace.dockLeft',
    right: 'workspace.dockRight',
    top: 'workspace.dockTop',
    bottom: 'workspace.dockBottom',
  }[dock.activeDockDropTarget.value?.edge || 'right']))

  function toggleAnalysisDock() {
    const nextVisible = !showAnalysisDock.value
    const analysisPanels = hasSelectedAnalysisPanels.value
      ? workspaceLayout.value.analysisPanels
      : { opponents: true, game: true, risk: false, counts: false }
    update({ ...workspaceLayout.value, analysisVisible: nextVisible, analysisPanels })
  }

  function toggleAnalysisPanel(key: AnalysisPanelKey) {
    const nextSelected = !workspaceLayout.value.analysisPanels[key]
    const analysisPanels = { ...workspaceLayout.value.analysisPanels, [key]: nextSelected }
    const anySelected = Object.values(analysisPanels).some(Boolean)
    update({
      ...workspaceLayout.value,
      analysisVisible: anySelected && (workspaceLayout.value.analysisVisible || nextSelected),
      analysisPanels,
    })
  }

  function closeAnalysisPanel(id: AnalysisPanelId) {
    const definition = analysisPanelDefinition(id)
    if (!definition) return
    const analysisPanels = { ...workspaceLayout.value.analysisPanels, [definition.key]: false }
    update({
      ...workspaceLayout.value,
      analysisVisible: Object.values(analysisPanels).some(Boolean)
        && workspaceLayout.value.analysisVisible,
      analysisPanels,
    })
  }

  function toggleConsoleDock() {
    update({ ...workspaceLayout.value, consoleVisible: !showConsoleDock.value })
  }

  function closeConsoleDock() {
    update({ ...workspaceLayout.value, consoleVisible: false })
  }

  return {
    ANALYSIS_PANEL_DEFINITIONS,
    analysisPanelIsSelected,
    analysisPanelSection,
    analysisPanelTitle,
    isAnalysisPanelId,
    closeAnalysisPanel,
    closeConsoleDock,
    dockDropLabel,
    showAnalysisDock,
    showConsoleDock,
    toggleAnalysisDock,
    toggleAnalysisPanel,
    toggleConsoleDock,
    workspaceLayout,
    ...dock,
  }
}
