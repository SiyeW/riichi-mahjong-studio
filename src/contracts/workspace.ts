export const WORKSPACE_ITEM_IDS = [
  'table',
  'console',
  'analysis-opponents',
  'analysis-game',
  'analysis-risk',
  'analysis-counts',
] as const

export type WorkspaceItemId = typeof WORKSPACE_ITEM_IDS[number]
export type AnalysisPanelId = Extract<WorkspaceItemId, `analysis-${string}`>
export type AnalysisPanelSection = 'opponents' | 'game' | 'risk' | 'counts'
export type DockPanelId = Exclude<WorkspaceItemId, 'table'>
export type DockDirection = 'horizontal' | 'vertical'
export type DockEdge = 'left' | 'right' | 'top' | 'bottom'

export type WorkspaceDockNode =
  | { type: 'item'; id: WorkspaceItemId }
  | {
      type: 'split'
      direction: DockDirection
      children: WorkspaceDockNode[]
      weights: number[]
    }

export type WorkspaceDockViewNode =
  | { type: 'item'; id: WorkspaceItemId }
  | {
      type: 'split'
      direction: DockDirection
      children: WorkspaceDockViewNode[]
      weights: number[]
      sourcePath: number[]
      sourceChildIndexes: number[]
    }

export type DockPanelSizeFractions = Partial<Record<
  DockPanelId,
  { horizontal?: number; vertical?: number }
>>

export interface WorkspaceLayoutSettings {
  layout: WorkspaceDockNode
  analysisVisible: boolean
  analysisPanels: {
    opponents: boolean
    game: boolean
    risk: boolean
    counts: boolean
  }
  consoleVisible: boolean
  panelSizeFractionsVersion: 2
  panelSizeFractions: DockPanelSizeFractions
}

export interface DockResizeRequest {
  direction: DockDirection
  sourcePath: number[]
  beforeIndex: number
  afterIndex: number
  beforeItems: WorkspaceItemId[]
  afterItems: WorkspaceItemId[]
  beforeSize: number
  afterSize: number
  event: PointerEvent
}
