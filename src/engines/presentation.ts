import type { SupportedEngineOutputId } from './useEngineCatalog.ts'

export type EngineLoadStatus = 'loaded' | 'loading' | 'error' | 'unloaded'

export interface EngineOutputFilterItem {
  id: SupportedEngineOutputId
  label: string
  status: EngineLoadStatus | null
  selected: boolean
}

export interface EngineProfileListItem {
  id: string
  name: string
  subtitle: string
  selected: boolean
  status: EngineLoadStatus
  showAction: boolean
  loaded: boolean
}

export interface EngineProfileDetailView {
  id: string
  name: string
  suggestedName: string
  locked: boolean
  enginePath: string
  outputs: Array<{ id: SupportedEngineOutputId; label: string; assigned: boolean }>
  unsupportedOutputs: boolean
  weights: Array<{ id: string; label: string; path: string }>
  devices: Array<{ type: string; label: string }>
  device: string
  licenses: Array<{ name: string; available: boolean }>
  notices: Array<{ name: string; available: boolean }>
  sourceUrl: string
  readingOptions: boolean
  options: Array<{
    key: string
    label: string
    type: string
    enumValues: Array<string | number | boolean> | null
    value: string | number | boolean
    defaultLabel: string
    placeholder: string
    inputMode?: 'numeric' | 'decimal'
  }>
  describeError: string
  catalogDiagnostic: string
}
