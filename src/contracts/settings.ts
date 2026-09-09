import type { EngineSettings } from './engines'
import type { WorkspaceDockNode } from '../workspaceLayout'

export interface StudioSettings {
  configPath: string
  runtime?: {
    releaseMode: boolean
    builtInRuntimeLabel: string
    builtInModelLabel: string
    opponentAnalysisInputModes: Array<'public' | 'full-information'>
    engineCatalog: {
      schemaVersion: number
      engines: Array<{
        id: string
        name: string
        version: string
        builtIn: boolean
        enginePath: string
        protocol: { name: string; major: number; minor: number }
        licenses: Array<{ name: string; available: boolean }>
        notices: Array<{ name: string; available: boolean }>
        sourceUrl: string
        launch: {
          executable: string
          arguments: string[]
          cwd: string
        } | null
      }>
      diagnostics: Array<{
        severity: 'error' | 'warning'
        code: string
        path: string
        message: string
      }>
    }
    soundPackCatalog: {
      schemaVersion: number
      packs: Array<{
        id: string
        name: string
        version: string
        builtIn: boolean
        sounds: Record<string, string>
      }>
      diagnostics: Array<{
        severity: 'error' | 'warning'
        code: string
        path: string
        message: string
      }>
    }
  }
  training: {
    mode: 'no_review' | 'threshold_review' | 'always_review' | 'preview_before_click'
    mistakeThreshold: number
    thinkingTimeMinS: number
    thinkingTimeMaxS: number
  }
  modeDefaults: {
    autoAdvanceDelayMs: number
  }
  display: {
    language: 'system' | 'zh-CN' | 'ja-JP' | 'en-US'
    colorScheme: 'default' | 'killerducky' | 'naga'
    reduceMotion: boolean
    uiScale: number
    showTsumogiriInPlay: boolean
    tablePosition: 'left' | 'center' | 'right'
    workspaceLayout: {
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
      panelSizeFractions: Partial<Record<
        'console' | 'analysis-opponents' | 'analysis-game' | 'analysis-risk' | 'analysis-counts',
        { horizontal?: number; vertical?: number }
      >>
    }
  }
  records: {
    saveRecoveryOnExit: boolean
  }
  audio: {
    volume: number
    soundPackId: string
  }
  engines: EngineSettings
}

export type SettingsPatch = {
  [K in 'training' | 'modeDefaults' | 'display' | 'records' | 'audio']?: Partial<StudioSettings[K]>
} & { engines?: EngineSettings }
