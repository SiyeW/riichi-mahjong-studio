import { normalizeWorkspaceDockLayout } from './layout.ts'
import type {
  DockDirection,
  DockPanelId,
  DockPanelSizeFractions,
  WorkspaceLayoutSettings,
} from '../contracts/workspace.ts'

export type { DockPanelId, DockPanelSizeFractions } from '../contracts/workspace.ts'

const DOCK_PANEL_IDS: readonly DockPanelId[] = [
  'console',
  'analysis-opponents',
  'analysis-game',
  'analysis-risk',
  'analysis-counts',
]

const DEFAULT_DOCK_PANEL_SIZE_FRACTIONS: DockPanelSizeFractions = {
  console: { horizontal: 0.185, vertical: 0.32 },
  'analysis-opponents': { horizontal: 0.212, vertical: 0.32 },
  'analysis-game': { horizontal: 0.254, vertical: 0.32 },
  'analysis-risk': { horizontal: 0.167, vertical: 0.32 },
  'analysis-counts': { horizontal: 0.29, vertical: 0.32 },
}

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

export function normalizeWorkspaceLayout(value: unknown): WorkspaceLayoutSettings {
  const source = value && typeof value === 'object'
    ? value as Partial<WorkspaceLayoutSettings> & { order?: unknown }
    : {}
  const sourcePanels: Partial<WorkspaceLayoutSettings['analysisPanels']> = source.analysisPanels && typeof source.analysisPanels === 'object'
    ? source.analysisPanels
    : {}
  const usesLegacyDefaults = source.layout === undefined && source.order !== undefined
  return {
    layout: normalizeWorkspaceDockLayout(source.layout, source.order),
    analysisVisible: source.analysisVisible === undefined
      ? !usesLegacyDefaults
      : source.analysisVisible === true,
    analysisPanels: {
      opponents: sourcePanels.opponents === undefined ? true : sourcePanels.opponents === true,
      game: sourcePanels.game === undefined ? true : sourcePanels.game === true,
      risk: sourcePanels.risk === undefined ? !usesLegacyDefaults : sourcePanels.risk === true,
      counts: sourcePanels.counts === undefined ? !usesLegacyDefaults : sourcePanels.counts === true,
    },
    consoleVisible: source.consoleVisible !== false,
    panelSizeFractionsVersion: 2,
    panelSizeFractions: source.panelSizeFractionsVersion === 2
      ? normalizeDockPanelSizeFractions(source.panelSizeFractions)
      : source.layout === undefined && source.order === undefined
        ? normalizeDockPanelSizeFractions(DEFAULT_DOCK_PANEL_SIZE_FRACTIONS)
        : {},
  }
}
