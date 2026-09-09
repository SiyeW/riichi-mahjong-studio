import { computed, reactive, ref, watchEffect } from 'vue'
import { settingsChanges, mergeSettingsReply } from './settingsChanges'
import { normalizeLanguagePreference, setLanguagePreference } from './i18n'
import { normalizeWorkspaceLayout } from './workspaceSettings'
import { DEFAULT_ANALYSIS_COUNT_LAYOUT, type AnalysisCountLayout } from './analysisCountSpacing'
import { mostDistinctOklabColor, parseCssColor, type RgbColor } from './perceptualColor'
import type { StudioSettings } from './contracts/settings'
import {
  DEFAULT_PERCEPTUAL_SURFACE_TUNING,
  PERCEPTUAL_COLOR_CALIBRATION_BACKGROUND,
  perceptualSurfaceVariables,
  type PerceptualColorPalette,
  type PerceptualSurfaceBinding,
  type PerceptualSurfaceTuning,
} from './perceptualSurface'

type Translate = (key: string, params?: Record<string, string | number>) => string
type ColorSchemeId = StudioSettings['display']['colorScheme']
type TablePosition = StudioSettings['display']['tablePosition']

export function useSettingsSession(t: Translate) {
  const DEFAULT_SHANTEN_COLORS = [
    '#4CAF50',
    '#2B8CBE',
    '#1476B0',
    '#0868AC',
    '#08589E',
    '#084081',
    '#062B5C',
    '#4E6263',
  ]
  const COLOR_SCHEMES: Record<ColorSchemeId, {
    decisionRecommendation: string
    ronWait: { kamicha: string; toimen: string; shimocha: string }
    selfDealIn?: string
    shanten: string[]
  }> = {
    default: {
      decisionRecommendation: '#1a931a',
      ronWait: { kamicha: '#2c8fc5', toimen: '#d39a3a', shimocha: '#4caf50' },
      selfDealIn: '#c9554d',
      shanten: DEFAULT_SHANTEN_COLORS,
    },
    killerducky: {
      decisionRecommendation: '#1a931a',
      ronWait: { kamicha: '#b34d4d', toimen: '#4db3b3', shimocha: '#804db3' },
      shanten: DEFAULT_SHANTEN_COLORS,
    },
    naga: {
      decisionRecommendation: '#1a931a',
      ronWait: { kamicha: '#2196f3', toimen: '#ffeb3b', shimocha: '#4caf50' },
      shanten: DEFAULT_SHANTEN_COLORS,
    },
  }

  function normalizeColorScheme(value: unknown): ColorSchemeId {
    return value === 'killerducky' || value === 'naga' ? value : 'default'
  }

  function normalizeTablePosition(value: unknown): TablePosition {
    return value === 'left' || value === 'right' ? value : 'center'
  }

  const settings = reactive<StudioSettings>({
    configPath: '',
    runtime: {
      releaseMode: false,
      builtInRuntimeLabel: '',
      builtInModelLabel: '',
      opponentAnalysisInputModes: ['public'],
      engineCatalog: {
        schemaVersion: 2,
        engines: [],
        diagnostics: [],
      },
      soundPackCatalog: {
        schemaVersion: 1,
        packs: [],
        diagnostics: [],
      },
    },
    training: {
      mode: 'threshold_review',
      mistakeThreshold: 0.25,
      thinkingTimeMinS: 0.25,
      thinkingTimeMaxS: 1,
    },
    modeDefaults: {
      autoAdvanceDelayMs: 250,
    },
    display: {
      language: 'system',
      colorScheme: 'default',
      reduceMotion: false,
      uiScale: 1,
      showTsumogiriInPlay: true,
      tablePosition: 'center',
      workspaceLayout: normalizeWorkspaceLayout(null),
    },
    records: {
      saveRecoveryOnExit: true,
    },
    audio: {
      volume: 50,
      soundPackId: '',
    },
    engines: {
      schemaVersion: 2,
      profiles: [],
      loadedProfileIds: [],
      outputAssignments: {
        'action-recommendation': '',
        'opponent-shanten': '',
        'opponent-deal-in-probability': '',
        'opponent-concealed-tile-count': '',
        'wall-tile-count': '',
        'opponent-dora-count': '',
        'opponent-score': '',
        'kyoku-outcome': '',
        'kyoku-score-delta': '',
        'match-placement': '',
        'match-score': '',
      },
    },
  })
  const reduceMotionEnabled = computed(() => Boolean(settings.display.reduceMotion))
  const activeColorScheme = computed(() => COLOR_SCHEMES[normalizeColorScheme(settings.display.colorScheme)])
  const activePerceptualColorPalette = computed<PerceptualColorPalette>(() => {
    const scheme = activeColorScheme.value
    const fallback: RgbColor = [128, 128, 128]
    const kamicha = parseCssColor(scheme.ronWait.kamicha, fallback)
    const toimen = parseCssColor(scheme.ronWait.toimen, fallback)
    const shimocha = parseCssColor(scheme.ronWait.shimocha, fallback)
    const selfDealIn = scheme.selfDealIn
      ? parseCssColor(scheme.selfDealIn, [201, 85, 77])
      : mostDistinctOklabColor([kamicha, toimen, shimocha])
    return {
      decisionRecommendation: parseCssColor(scheme.decisionRecommendation, [26, 147, 26]),
      kamicha,
      toimen,
      shimocha,
      selfDealIn,
    }
  })
  const perceptualSurfaceTuning = reactive({ ...DEFAULT_PERCEPTUAL_SURFACE_TUNING })
  const perceptualSurfaceBypassed = ref(false)
  const analysisCountLayout = ref<AnalysisCountLayout>(DEFAULT_ANALYSIS_COUNT_LAYOUT)
  const showPerceptualColorDebugger = ref(false)
  const effectivePerceptualSurfaceTuning = computed<PerceptualSurfaceTuning>(() => (
    perceptualSurfaceBypassed.value
      ? {
          lightnessCompensation: 0,
          chromaticCompensation: 0,
          surfaceChromaGain: 0,
        }
      : perceptualSurfaceTuning
  ))
  const activePerceptualSurfaceBinding = computed<PerceptualSurfaceBinding>(() => ({
    palette: activePerceptualColorPalette.value,
    tuning: effectivePerceptualSurfaceTuning.value,
    debugLabel: 'table-panel',
  }))
  const colorSchemeCssVariables = computed(() => perceptualSurfaceVariables(
    activePerceptualColorPalette.value,
    PERCEPTUAL_COLOR_CALIBRATION_BACKGROUND,
    effectivePerceptualSurfaceTuning.value,
  ))

  function updatePerceptualSurfaceTuning(value: PerceptualSurfaceTuning) {
    Object.assign(perceptualSurfaceTuning, value)
  }

  function resetPerceptualSurfaceTuning() {
    Object.assign(perceptualSurfaceTuning, DEFAULT_PERCEPTUAL_SURFACE_TUNING)
    perceptualSurfaceBypassed.value = false
  }

  const shantenColors = computed(() => activeColorScheme.value.shanten)
  const UI_SCALE_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

  function normalizeUiScale(value: unknown): number {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return 1
    return Math.round(Math.max(0.5, Math.min(2, numeric)) * 100) / 100
  }

  const uiScale = computed(() => normalizeUiScale(settings.display.uiScale))
  const tablePosition = computed(() => normalizeTablePosition(settings.display.tablePosition))

  watchEffect(() => {
    document.documentElement.classList.toggle('reduce-motion', reduceMotionEnabled.value)
  })

  const settingsDraft = reactive<StudioSettings>(JSON.parse(JSON.stringify(settings)))
  const mistakeThresholdDisplay = computed({
    get: () => Math.round(Math.max(0, Math.min(1, settingsDraft.training.mistakeThreshold)) * 100),
    set: (value: number) => {
      const percentage = Number(value)
      if (!Number.isFinite(percentage)) return
      settingsDraft.training.mistakeThreshold = Math.max(0, Math.min(100, percentage)) / 100
    },
  })
  const uiScaleOptions = computed(() => {
    const values = new Set([...UI_SCALE_STEPS, normalizeUiScale(settingsDraft.display.uiScale)])
    return [...values].sort((a, b) => a - b)
  })
  const showSettingsPanel = ref(false)

  watchEffect(() => {
    setLanguagePreference(showSettingsPanel.value
      ? settingsDraft.display.language
      : settings.display.language)
  })


  const quickThinkingDragValue = ref<number | null>(null)
  const quickVolumeDragValue = ref<number | null>(null)
  const currentTrainingMode = computed(() => normalizeTrainingMode(settings.training.mode))
  const quickThinkingMaxValue = computed(() => quickThinkingDragValue.value ?? settings.training.thinkingTimeMaxS)
  const quickAudioVolumeValue = computed(() => quickVolumeDragValue.value ?? settings.audio.volume)
  const quickMaxThinkingPercent = computed(() => Math.max(0, Math.min(100, (quickThinkingMaxValue.value / 4) * 100)))
  const quickAudioVolumePercent = computed(() => Math.max(0, Math.min(100, quickAudioVolumeValue.value)))
  const quickMinThinkingPercent = computed(() => Math.max(0, Math.min(100, (settings.training.thinkingTimeMinS / 4) * 100)))
  const quickAutoAdvancePercent = computed(() => Math.max(0, Math.min(100, ((settings.modeDefaults.autoAdvanceDelayMs / 1000) / 4) * 100)))
  const quickMaxThinkingLabel = computed(() => `${quickThinkingMaxValue.value.toFixed(2)}s`)
  const quickAudioVolumeLabel = computed(() => `${Math.round(quickAudioVolumeValue.value)}`)
  const quickMinThinkingLabel = computed(() => `${settings.training.thinkingTimeMinS.toFixed(2)}s`)
  const quickAutoAdvanceLabel = computed(() => `${(settings.modeDefaults.autoAdvanceDelayMs / 1000).toFixed(2)}s`)

  function normalizeTrainingMode(mode: string): StudioSettings['training']['mode'] {
    const MAP: Record<string, StudioSettings['training']['mode']> = {
      no_review: 'no_review',
      free_play: 'preview_before_click',
      guided: 'threshold_review',
      strict: 'always_review',
      preview_before_click: 'preview_before_click',
      threshold_review: 'threshold_review',
      always_review: 'always_review',
    }
    return MAP[String(mode || '')] || 'threshold_review'
  }

  function applySettings(nextSettings: StudioSettings) {
    Object.assign(settings, nextSettings)
    Object.assign(settings.training, nextSettings.training, {
      mode: normalizeTrainingMode(nextSettings.training.mode),
    })
    Object.assign(settings.modeDefaults, nextSettings.modeDefaults)
    Object.assign(settings.display, nextSettings.display || {}, {
      language: normalizeLanguagePreference(nextSettings.display?.language),
      colorScheme: normalizeColorScheme(nextSettings.display?.colorScheme),
      uiScale: normalizeUiScale(nextSettings.display?.uiScale),
      showTsumogiriInPlay: nextSettings.display?.showTsumogiriInPlay !== false,
      tablePosition: normalizeTablePosition(nextSettings.display?.tablePosition),
      workspaceLayout: normalizeWorkspaceLayout(nextSettings.display?.workspaceLayout),
    })
    Object.assign(settings.records, nextSettings.records || {})
    Object.assign(settings.audio, nextSettings.audio)
    Object.assign(settings.engines, nextSettings.engines)
  }


  function cloneSettingsDraftFromCurrent() {
    Object.assign(settingsDraft, JSON.parse(JSON.stringify(settings)), { engines: settingsDraft.engines })
  }


  let settingsPanelBaseline: StudioSettings | null = null

  function openSettingsPanel() {
    cloneSettingsDraftFromCurrent()
    settingsPanelBaseline = JSON.parse(JSON.stringify(settings)) as StudioSettings
    showSettingsPanel.value = true
  }

  function closeSettingsPanel() {
    showSettingsPanel.value = false
  }

  async function saveSettingsPanel() {
    if (!window.trainerAPI) return
    settingsDraft.display.language = normalizeLanguagePreference(settingsDraft.display.language)
    settingsDraft.display.colorScheme = normalizeColorScheme(settingsDraft.display.colorScheme)
    settingsDraft.display.uiScale = normalizeUiScale(settingsDraft.display.uiScale)
    settingsDraft.display.tablePosition = normalizeTablePosition(settingsDraft.display.tablePosition)
    settingsDraft.display.workspaceLayout = normalizeWorkspaceLayout(settingsDraft.display.workspaceLayout)
    settingsDraft.training.mistakeThreshold = Math.max(
      0,
      Math.min(1, Number(settingsDraft.training.mistakeThreshold) || 0),
    )
    const baseline = settingsPanelBaseline
    const submitted = JSON.parse(JSON.stringify(settingsDraft)) as StudioSettings
    const patch = settingsChanges(baseline || settings, submitted)
    const saved = await window.trainerAPI.saveSettings(patch)
    applySettings(mergeSettingsReply(settings, saved, patch))
    if (settingsPanelBaseline === baseline) {
      settingsPanelBaseline = submitted
      if (!Object.keys(settingsChanges(submitted, settingsDraft)).length) showSettingsPanel.value = false
    }
  }

  async function saveQuickSettings(mutator: (draft: StudioSettings) => void) {
    if (!window.trainerAPI) return
    const next = JSON.parse(JSON.stringify(settings)) as StudioSettings
    mutator(next)
    next.training.mode = normalizeTrainingMode(next.training.mode)
    const patch = settingsChanges(settings, next)
    const saved = await window.trainerAPI.saveSettings(patch)
    applySettings(mergeSettingsReply(settings, saved, patch))
  }

  async function setQuickTrainingMode(mode: StudioSettings['training']['mode']) {
    if (currentTrainingMode.value === mode) return
    await saveQuickSettings((next) => {
      next.training.mode = mode
    })
  }

  async function onQuickAudioVolumeInput(event: Event) {
    const target = event.target as HTMLInputElement | null
    if (!target) return
    quickVolumeDragValue.value = Math.max(0, Math.min(100, Number(target.value || 0)))
  }

  async function commitQuickAudioVolume(event: Event) {
    const target = event.target as HTMLInputElement | null
    if (!target) return
    const volume = Math.max(0, Math.min(100, Number(target.value || 0)))
    await saveQuickSettings((next) => {
      next.audio.volume = volume
    })
    quickVolumeDragValue.value = null
  }

  async function onQuickThinkingTimeInput(event: Event) {
    const target = event.target as HTMLInputElement | null
    if (!target) return
    quickThinkingDragValue.value = Math.max(0, Math.min(4, Number(target.value || 0)))
  }

  async function commitQuickThinkingTime(event: Event) {
    const target = event.target as HTMLInputElement | null
    if (!target) return
    const maxS = Math.max(0, Math.min(4, Number(target.value || 0)))
    const quarter = maxS / 4
    await saveQuickSettings((next) => {
      next.training.thinkingTimeMaxS = maxS
      next.training.thinkingTimeMinS = quarter
      next.modeDefaults.autoAdvanceDelayMs = Math.round(quarter * 1000)
    })
    quickThinkingDragValue.value = null
  }


  function nextUiScale(direction: 'in' | 'out' | 'reset'): number {
    if (direction === 'reset') return 1
    const current = uiScale.value
    if (direction === 'in') {
      return UI_SCALE_STEPS.find((step) => step > current + 0.001) ?? UI_SCALE_STEPS.at(-1) ?? 2
    }
    return [...UI_SCALE_STEPS].reverse().find((step) => step < current - 0.001) ?? UI_SCALE_STEPS[0]
  }

  async function changeUiScale(direction: 'in' | 'out' | 'reset') {
    const next = nextUiScale(direction)
    if (next === uiScale.value) return
    settings.display.uiScale = next
    if (showSettingsPanel.value) settingsDraft.display.uiScale = next
    try {
      await window.trainerAPI?.saveSettings({
        display: { uiScale: next },
      })
    } catch (error) {
      console.warn('Failed to save UI scale:', error)
    }
  }


  return {
    settings,
    settingsDraft,
    reduceMotionEnabled,
    activePerceptualSurfaceBinding,
    colorSchemeCssVariables,
    perceptualSurfaceTuning,
    perceptualSurfaceBypassed,
    analysisCountLayout,
    showPerceptualColorDebugger,
    updatePerceptualSurfaceTuning,
    resetPerceptualSurfaceTuning,
    shantenColors,
    uiScale,
    tablePosition,
    mistakeThresholdDisplay,
    uiScaleOptions,
    showSettingsPanel,
    currentTrainingMode,
    quickThinkingMaxValue,
    quickAudioVolumeValue,
    quickMaxThinkingPercent,
    quickAudioVolumePercent,
    quickMinThinkingPercent,
    quickAutoAdvancePercent,
    quickMaxThinkingLabel,
    quickAudioVolumeLabel,
    quickMinThinkingLabel,
    quickAutoAdvanceLabel,
    normalizeTrainingMode,
    applySettings,
    cloneSettingsDraftFromCurrent,
    openSettingsPanel,
    closeSettingsPanel,
    saveSettingsPanel,
    setQuickTrainingMode,
    onQuickAudioVolumeInput,
    commitQuickAudioVolume,
    onQuickThinkingTimeInput,
    commitQuickThinkingTime,
    changeUiScale,
  }
}
