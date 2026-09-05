import { normalizeWorkspaceDockLayout, type WorkspaceItemId, type DockDirection } from './workspaceLayout.ts'

export type DockPanelId = Exclude<WorkspaceItemId, 'table'>
export type DockPanelSizeFractions = TrainerSettings['display']['workspaceLayout']['panelSizeFractions']

const DOCK_PANEL_IDS: readonly DockPanelId[] = [
  'console',
  'analysis-opponents',
  'analysis-game',
  'analysis-risk',
  'analysis-counts',
]

export function normalizeDockPanelFraction(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 && numeric < 1
    ? Math.max(0.08, Math.min(0.8, numeric))
    : null
}

export function normalizeDockPanelSizeFractions(value: unknown): DockPanelSizeFractions {
  if (!value || typeof value !== 'object') return {}
  const source = value as Partial<Record<DockPanelId, Record<DockDirection, unknown>>>
  const normalized: DockPanelSizeFractions = {}
  for (const panelId of DOCK_PANEL_IDS) {
    const sourcePanel = source[panelId]
    if (!sourcePanel || typeof sourcePanel !== 'object') continue
    const panel: { horizontal?: number; vertical?: number } = {}
    for (const direction of ['horizontal', 'vertical'] as const) {
      const fraction = normalizeDockPanelFraction(sourcePanel[direction])
      if (fraction !== null) panel[direction] = fraction
    }
    if (Object.keys(panel).length) normalized[panelId] = panel
  }
  return normalized
}

export function normalizeWorkspaceLayout(value: unknown): TrainerSettings['display']['workspaceLayout'] {
  const source = value && typeof value === 'object'
    ? value as Partial<TrainerSettings['display']['workspaceLayout']> & { order?: unknown }
    : {}
  const sourcePanels: Partial<TrainerSettings['display']['workspaceLayout']['analysisPanels']> = source.analysisPanels && typeof source.analysisPanels === 'object'
    ? source.analysisPanels
    : {}
  return {
    layout: normalizeWorkspaceDockLayout(source.layout, source.order),
    analysisVisible: source.analysisVisible === true,
    analysisPanels: {
      opponents: sourcePanels.opponents !== false,
      game: sourcePanels.game !== false,
      risk: sourcePanels.risk === true,
      counts: sourcePanels.counts === true,
    },
    consoleVisible: source.consoleVisible !== false,
    panelSizeFractionsVersion: 2,
    panelSizeFractions: source.panelSizeFractionsVersion === 2
      ? normalizeDockPanelSizeFractions(source.panelSizeFractions)
      : {},
  }
}
