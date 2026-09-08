import { computed, onBeforeUnmount, reactive, ref, watch, type Ref } from 'vue'
import { createRevisionSaveQueue } from './revisionSaveQueue'
import { mergeSettingsReply } from './settingsChanges'
import type { TranslationParams } from './i18n'
import { buildEngineStatusItems, type EngineRuntimeKind } from './engineStatusItems'
import { useEngineRuntimeProfiles } from './useEngineRuntimeProfiles'

export type SupportedEngineOutputId =
  | 'action-recommendation'
  | 'opponent-shanten'
  | 'opponent-deal-in-probability'
  | 'opponent-concealed-tile-count'
  | 'wall-tile-count'
  | 'opponent-dora-count'
  | 'opponent-score'
  | 'kyoku-outcome'
  | 'kyoku-score-delta'
  | 'match-placement'
  | 'match-score'

type Translate = (key: string, params?: TranslationParams) => string

interface UseEngineProfilesOptions {
  settings: TrainerSettings
  settingsDraft: TrainerSettings
  status: TrainerStatusSnapshot
  locale: Readonly<Ref<string>>
  t: Translate
  closeSettingsPanel: () => void
  focus: () => void
  applySettings: (settings: TrainerSettings) => void
  applyStatus: (status: TrainerStatusSnapshot) => void
  afterOpponentUnload: () => void | Promise<void>
}

const SUPPORTED_ENGINE_OUTPUT_DEFINITIONS: Array<{ id: SupportedEngineOutputId; labelKey: string }> = [
  { id: 'action-recommendation', labelKey: 'analysis.output.action' },
  { id: 'opponent-shanten', labelKey: 'analysis.output.shanten' },
  { id: 'opponent-deal-in-probability', labelKey: 'analysis.output.dealIn' },
  { id: 'opponent-concealed-tile-count', labelKey: 'analysis.output.concealedTiles' },
  { id: 'wall-tile-count', labelKey: 'analysis.output.wallTiles' },
  { id: 'opponent-dora-count', labelKey: 'analysis.output.dora' },
  { id: 'opponent-score', labelKey: 'analysis.output.score' },
  { id: 'kyoku-outcome', labelKey: 'analysis.output.kyokuOutcome' },
  { id: 'kyoku-score-delta', labelKey: 'analysis.output.kyokuDelta' },
  { id: 'match-placement', labelKey: 'analysis.output.matchPlacement' },
  { id: 'match-score', labelKey: 'analysis.output.matchScore' },
]

const DELETE_CONFIRMATION_TIMEOUT_MS = 3000
const ENGINE_AUTOSAVE_DELAY_MS = 250

function cloneEngineSettings(engines: TrainerEngineSettings): TrainerEngineSettings {
  return JSON.parse(JSON.stringify(engines)) as TrainerEngineSettings
}

export function useEngineProfiles(options: UseEngineProfilesOptions) {
  const {
    settings,
    settingsDraft,
    status,
    locale,
    t,
    closeSettingsPanel,
    focus,
    applySettings,
    applyStatus,
    afterOpponentUnload,
  } = options

  const SUPPORTED_ENGINE_OUTPUTS = computed(() => SUPPORTED_ENGINE_OUTPUT_DEFINITIONS.map((output) => ({
    id: output.id,
    label: t(output.labelKey),
  })))
  const opponentEngineOutputIds = SUPPORTED_ENGINE_OUTPUT_DEFINITIONS
    .map((output) => output.id)
    .filter((outputId): outputId is Exclude<SupportedEngineOutputId, 'action-recommendation'> => (
      outputId !== 'action-recommendation'
    ))

  const showEngineWindow = ref(false)
  const engineSaveMessage = ref('')
  const loadingEngineProfileId = ref('')
  const unloadingEngineProfileId = ref('')
  const deleteEngineConfirmationId = ref('')
  const describingEngineIds = reactive(new Set<string>())
  const engineOutputFilter = ref<SupportedEngineOutputId | null>(null)
  const editingEngineProfileId = ref('')
  const engineDescriptions = reactive<Record<string, TrainerEngineDescription>>({})
  const engineDescribeErrors = reactive<Record<string, string>>({})
  const engineLoadErrors = reactive<Record<string, string>>({})
  let deleteEngineConfirmationTimer: number | null = null
  let engineAutosaveTimer: number | null = null
  let suppressEngineAutosave = false
  let engineAutosaveEnabled = false

  const engineSaves = createRevisionSaveQueue(
    () => cloneEngineSettings(settingsDraft.engines),
    saveEngineDraftSnapshot,
  )

  const activeEngineProfiles = computed(() => settingsDraft.engines.profiles)
  const filteredEngineProfiles = computed(() => {
    const outputId = engineOutputFilter.value
    if (!outputId) return activeEngineProfiles.value
    return activeEngineProfiles.value.filter((profile) => engineProfileSupportsOutput(profile, outputId))
  })
  const activeEngineProfile = computed(() => (
    filteredEngineProfiles.value.find((profile) => profile.id === editingEngineProfileId.value)
    || filteredEngineProfiles.value[0]
    || null
  ))
  const activeEngineProfileIndex = computed(() => (
    activeEngineProfiles.value.findIndex((profile) => profile.id === activeEngineProfile.value?.id)
  ))
  const engineCatalogDiagnostics = computed(() => settings.runtime?.engineCatalog?.diagnostics || [])
  const activeCatalogEngine = computed(() => (
    settings.runtime?.engineCatalog?.engines.find(
      (engine) => engine.id === activeEngineProfile.value?.engineId,
    ) || null
  ))
  const activeEngineDescription = computed(() => (
    engineDescriptions[engineDescriptionKey(activeEngineProfile.value)] || null
  ))

  function supportedOutputsForProfile(profile: TrainerEngineProfile) {
    const contracts = engineDescriptions[engineDescriptionKey(profile)]?.outputContracts || []
    return SUPPORTED_ENGINE_OUTPUTS.value.filter((supported) => contracts.some((contract) => (
      contract.id === supported.id
    )))
  }

  const activeSupportedOutputs = computed(() => {
    const profile = activeEngineProfile.value
    return profile ? supportedOutputsForProfile(profile) : []
  })

  function weightSlotsForProfile(profile: TrainerEngineProfile) {
    const description = engineDescriptions[engineDescriptionKey(profile)]
    const supportedIds = new Set(supportedOutputsForProfile(profile).map((output) => output.id))
    return (description?.weightSlots || []).filter((slot) => (
      slot.requiredForOutputs?.some((output) => supportedIds.has(output.id as SupportedEngineOutputId)) === true
    ))
  }

  const activeEngineWeightSlots = computed(() => {
    const profile = activeEngineProfile.value
    return profile ? weightSlotsForProfile(profile) : []
  })
  const activeEngineDevices = computed(() => activeEngineDescription.value?.devices || [])
  const activeEngineOptionEntries = computed(() => {
    const properties = activeEngineDescription.value?.optionsSchema?.properties || {}
    return Object.entries(properties)
      .filter(([key]) => key !== 'device')
      .map(([key, schema]) => ({
        key,
        label: schema['x-ui']?.label || key,
        type: schema.type || 'string',
        enumValues: Array.isArray(schema.enum) ? schema.enum : null,
        minimum: schema.minimum,
        maximum: schema.maximum,
        defaultValue: schema.default,
      }))
  })

  function openEngineWindow() {
    cancelEngineAutosaveTimer()
    if (!engineSaves.saving && !engineSaves.pending) {
      replaceEngineDraft(settings.engines)
    }
    engineAutosaveEnabled = true
    closeSettingsPanel()
    showEngineWindow.value = true
    engineSaveMessage.value = ''
    deleteEngineConfirmationId.value = ''
    if (!settingsDraft.engines.profiles.some((profile) => profile.id === editingEngineProfileId.value)) {
      editingEngineProfileId.value = settingsDraft.engines.profiles[0]?.id || ''
    }
    for (const profile of activeEngineProfiles.value) {
      void describeEngineProfile(profile)
    }
    focus()
  }

  function closeEngineWindow() {
    showEngineWindow.value = false
    void flushEngineAutosave()
  }

  function selectEngineProfile(profileId: string) {
    editingEngineProfileId.value = profileId
    deleteEngineConfirmationId.value = ''
    const profile = activeEngineProfiles.value.find((item) => item.id === profileId) || null
    void describeEngineProfile(profile)
  }

  function toggleEngineOutputFilter(outputId: SupportedEngineOutputId) {
    engineOutputFilter.value = engineOutputFilter.value === outputId ? null : outputId
  }

  watch(deleteEngineConfirmationId, (profileId) => {
    if (deleteEngineConfirmationTimer !== null) {
      window.clearTimeout(deleteEngineConfirmationTimer)
      deleteEngineConfirmationTimer = null
    }
    if (!profileId) return
    deleteEngineConfirmationTimer = window.setTimeout(() => {
      if (deleteEngineConfirmationId.value === profileId) {
        deleteEngineConfirmationId.value = ''
      }
    }, DELETE_CONFIRMATION_TIMEOUT_MS)
  })

  function catalogEngineForProfile(profile: TrainerEngineProfile | null) {
    return settings.runtime?.engineCatalog?.engines.find((engine) => (
      engine.id === profile?.engineId
      || engine.enginePath.toLowerCase() === String(profile?.enginePath || '').toLowerCase()
    )) || null
  }

  function engineDescriptionKey(profile: TrainerEngineProfile | null): string {
    return String(profile?.enginePath || profile?.engineId || '')
  }

  function engineProfileSupportsOutput(
    profile: TrainerEngineProfile,
    outputId: SupportedEngineOutputId,
  ): boolean {
    const description = engineDescriptions[engineDescriptionKey(profile)]
    const supported = SUPPORTED_ENGINE_OUTPUTS.value.find((output) => output.id === outputId)
    return Boolean(supported && description?.outputContracts.some((contract) => (
      contract.id === supported.id
    )))
  }

  function engineOutputAssignmentProfile(outputId: SupportedEngineOutputId): TrainerEngineProfile | null {
    const profileId = settingsDraft.engines.outputAssignments[outputId]
    return activeEngineProfiles.value.find((profile) => profile.id === profileId) || null
  }

  function engineOutputRuntimeKind(outputId: SupportedEngineOutputId): EngineRuntimeKind {
    return outputId === 'action-recommendation' ? 'decision' : 'opponent'
  }

  function engineOutputAssignmentIsLoaded(outputId: SupportedEngineOutputId): boolean {
    const profile = engineOutputAssignmentProfile(outputId)
    return Boolean(profile && profileRuntimeState(profile, engineOutputRuntimeKind(outputId))?.ready)
  }

  function engineOutputAssignmentIsLoading(outputId: SupportedEngineOutputId): boolean {
    const profile = engineOutputAssignmentProfile(outputId)
    if (!profile || engineOutputAssignmentIsLoaded(outputId) || engineOutputAssignmentHasError(outputId)) return false
    if (loadingEngineProfileId.value === profile.id) return true
    const runtime = profileRuntimeState(profile, engineOutputRuntimeKind(outputId))
    return Boolean(runtime && !runtime.ready && !runtime.unloaded)
  }

  function engineOutputAssignmentHasError(outputId: SupportedEngineOutputId): boolean {
    const profile = engineOutputAssignmentProfile(outputId)
    if (!profile) return false
    const kind = engineOutputRuntimeKind(outputId)
    return Boolean(engineLoadErrors[profile.id])
      || (profileMatchesRuntime(profile, kind) && Boolean(runtimeEngineError(kind, profile)))
  }

  async function describeEngineProfile(profile: TrainerEngineProfile | null) {
    const key = engineDescriptionKey(profile)
    if (!profile?.enginePath || engineDescriptions[key] || describingEngineIds.has(key)) return
    if (!window.trainerAPI?.describeEngine) return
    describingEngineIds.add(key)
    delete engineDescribeErrors[key]
    try {
      const description = await window.trainerAPI.describeEngine({
        engineId: profile.engineId || undefined,
        engineVersion: profile.engineVersion || undefined,
        enginePath: profile.enginePath,
        engineCommand: Array.isArray(profile.engineCommand)
          ? profile.engineCommand.map(String)
          : [],
        engineCwd: profile.engineCwd,
      })
      engineDescriptions[key] = description
      if (profileConfigurationLocked(profile)) return
      profile.engineId = description.engine.id
      profile.engineVersion = description.engine.version
      if (!profile.device || !description.devices.some((device) => device.type === profile.device)) {
        profile.device = description.devices[0]?.type || ''
      }
    } catch (error) {
      engineDescribeErrors[key] = error instanceof Error ? error.message : String(error)
    } finally {
      describingEngineIds.delete(key)
    }
  }

  const {
    captureRuntimeEngineProfile,
    markConfiguredEngineStarting,
    profileMatchesRuntime,
    profileRuntimeKinds,
    profileRuntimeState,
    runtimeEngineError,
  } = useEngineRuntimeProfiles({
    status,
    opponentOutputIds: opponentEngineOutputIds,
    assignedOutputs: profileAssignedOutputs,
  })
  function profileIsLoaded(profile: TrainerEngineProfile): boolean {
    const runtimeGroups = profileRuntimeKinds(profile)
    return runtimeGroups.length > 0 && runtimeGroups.every((kind) => (
      profileRuntimeState(profile, kind)?.ready === true
    ))
  }

  function profileIsLoading(profile: TrainerEngineProfile): boolean {
    if (engineLoadErrors[profile.id]) return false
    if (profile.id === loadingEngineProfileId.value) return true
    return profileRuntimeKinds(profile).some((kind) => {
      const runtime = profileRuntimeState(profile, kind)
      return runtime !== null
        && !runtime.ready
        && !runtime.unloaded
        && !runtimeEngineError(kind, profile)
    })
  }

  function profileConfigurationLocked(profile: TrainerEngineProfile): boolean {
    return profileIsLoaded(profile) || profileIsLoading(profile)
  }

  function engineProfileClasses(profile: TrainerEngineProfile) {
    const runtimeGroups = profileRuntimeKinds(profile)
    const loaded = profileIsLoaded(profile)
    const matchesRuntime = runtimeGroups.some((kind) => profileMatchesRuntime(profile, kind))
    return {
      selected: profile.id === activeEngineProfile.value?.id,
      loaded,
      loading: profileIsLoading(profile),
      unloaded: matchesRuntime && runtimeGroups.every((kind) => (
        profileRuntimeState(profile, kind)?.unloaded === true
      )),
      error: Boolean(engineLoadErrors[profile.id])
        || runtimeGroups.some((kind) => (
          profileMatchesRuntime(profile, kind) && Boolean(runtimeEngineError(kind, profile))
        )),
      unavailable: !profile.enginePath || profileAssignedOutputs(profile).length === 0,
    }
  }

  function engineProfileSubtitle(profile: TrainerEngineProfile): string {
    if (profile.id === loadingEngineProfileId.value) return t('engine.status.loading')
    if (engineLoadErrors[profile.id]) return t('engine.status.failed')
    const runtimeGroups = profileRuntimeKinds(profile)
    if (!runtimeGroups.some((kind) => profileMatchesRuntime(profile, kind))) return ''
    if (runtimeGroups.some((kind) => runtimeEngineError(kind, profile))) return t('engine.status.failed')
    if (runtimeGroups.every((kind) => profileRuntimeState(profile, kind)?.unloaded === true)) return t('engine.status.notLoaded')
    if (!profileIsLoaded(profile)) return t('engine.status.loading')
    return t('engine.status.loaded')
  }

  const engineFooterMessage = computed(() => {
    const profile = activeEngineProfile.value
    const runtimeError = profile
      ? profileRuntimeKinds(profile)
        .filter((kind) => profileMatchesRuntime(profile, kind))
        .map((kind) => runtimeEngineError(kind, profile))
        .find(Boolean)
      : ''
    return runtimeError || engineSaveMessage.value
  })

  function shouldShowEngineActionButton(profile: TrainerEngineProfile): boolean {
    const loadOutputs = profileLoadOutputs(profile)
    return profileIsLoaded(profile)
      || (!profileIsLoading(profile)
        && Boolean(profile.enginePath && loadOutputs.length)
        && requiredWeightsReady(profile, loadOutputs)
        && !profileIsLoaded(profile))
  }

  function handleEngineProfileAction(profile: TrainerEngineProfile) {
    if (profileIsLoaded(profile)) void unloadEngineProfile(profile.id)
    else void loadEngineProfile(profile.id)
  }

  function moveEngineProfile(offset: number) {
    const profiles = activeEngineProfiles.value
    const from = activeEngineProfileIndex.value
    const to = from + offset
    if (from < 0 || to < 0 || to >= profiles.length) return
    const [profile] = profiles.splice(from, 1)
    profiles.splice(to, 0, profile)
  }

  function duplicateEngineProfile() {
    const source = activeEngineProfile.value
    if (!source) return
    const copyProfile: TrainerEngineProfile = JSON.parse(JSON.stringify(source))
    copyProfile.id = `profile.user.${Date.now().toString(36)}`
    copyProfile.name = t('engine.copySuffix', { name: source.name })
    copyProfile.builtIn = false
    copyProfile.autoName = false
    activeEngineProfiles.value.splice(activeEngineProfileIndex.value + 1, 0, copyProfile)
    selectEngineProfile(copyProfile.id)
  }

  function deleteEngineProfile() {
    const profile = activeEngineProfile.value
    const index = activeEngineProfileIndex.value
    if (!profile || profile.builtIn || profileAssignedOutputs(profile).length > 0 || index < 0) return
    if (deleteEngineConfirmationId.value !== profile.id) {
      deleteEngineConfirmationId.value = profile.id
      return
    }
    activeEngineProfiles.value.splice(index, 1)
    const next = activeEngineProfiles.value[Math.min(index, activeEngineProfiles.value.length - 1)]
    if (next) selectEngineProfile(next.id)
    deleteEngineConfirmationId.value = ''
  }

  function addEngineProfile() {
    engineOutputFilter.value = null
    const profile: TrainerEngineProfile = {
      id: `profile.user.${Date.now().toString(36)}`,
      name: '',
      engineId: '',
      enginePath: '',
      builtIn: false,
      available: false,
      autoName: true,
      weights: [],
      device: '',
      options: {},
    }
    activeEngineProfiles.value.push(profile)
    selectEngineProfile(profile.id)
  }

  function fileNameFromPath(value: string): string {
    return String(value || '').split(/[\\/]/).pop() || ''
  }

  function suggestedEngineProfileName(profile: TrainerEngineProfile): string {
    const engineName = engineDescriptions[engineDescriptionKey(profile)]?.engine.name
      || catalogEngineForProfile(profile)?.name
      || fileNameFromPath(profile.enginePath).replace(/\.[^.]+$/, '')
    const weightNames = (profile.weights || [])
      .map((weight) => fileNameFromPath(weight.path).replace(/\.[^.]+$/, ''))
      .filter(Boolean)
    return [engineName, ...weightNames].filter(Boolean).join(' + ')
  }

  function refreshAutomaticEngineName(profile: TrainerEngineProfile) {
    if (profile.autoName !== false && !profile.builtIn) profile.name = suggestedEngineProfileName(profile)
  }

  function setEngineProfileName(event: Event) {
    const profile = activeEngineProfile.value
    if (!profile || profileConfigurationLocked(profile)) return
    const value = (event.target as HTMLInputElement).value
    profile.name = value
    profile.autoName = !value.trim()
    if (profile.autoName) refreshAutomaticEngineName(profile)
  }

  async function chooseEngineFile() {
    const profile = activeEngineProfile.value
    if (!profile || profileConfigurationLocked(profile) || !window.trainerAPI?.chooseEngineFile) return
    const selectedPath = await window.trainerAPI.chooseEngineFile()
    if (!selectedPath || profileConfigurationLocked(profile)) return
    profile.enginePath = selectedPath
    profile.engineCommand = [selectedPath]
    profile.engineCwd = ''
    profile.engineId = ''
    profile.engineVersion = ''
    profile.weights = []
    profile.device = ''
    profile.options = {}
    profile.available = false
    delete engineLoadErrors[profile.id]
    refreshAutomaticEngineName(profile)
    await describeEngineProfile(profile)
    refreshAutomaticEngineName(profile)
  }

  async function chooseEngineWeight(slotId: string) {
    const profile = activeEngineProfile.value
    if (!profile || profileConfigurationLocked(profile) || !window.trainerAPI?.chooseEngineWeight) return
    const selectedPath = await window.trainerAPI.chooseEngineWeight()
    if (!selectedPath || profileConfigurationLocked(profile)) return
    const slot = activeEngineWeightSlots.value.find((item) => item.id === slotId)
    if (!slot) return
    const extension = selectedPath.match(/\.[^.\\/]+$/)?.[0]?.toLowerCase() || ''
    const format = slot.formats.find((item) => (
      Array.isArray(item.extensions)
      && item.extensions.map((value) => String(value).toLowerCase()).includes(extension)
    )) || slot.formats[0]
    const weights = profile.weights || (profile.weights = [])
    const next = { slotId, format: String(format?.id || ''), path: selectedPath }
    const index = weights.findIndex((weight) => weight.slotId === slotId)
    if (index >= 0) weights.splice(index, 1, next)
    else weights.push(next)
    profile.available = true
    delete engineLoadErrors[profile.id]
    refreshAutomaticEngineName(profile)
  }

  function localizedEngineText(value: string | Record<string, string> | undefined, fallback: string): string {
    if (typeof value === 'string') return value
    const language = locale.value.split('-')[0]
    return value?.[locale.value]
      || value?.[language]
      || value?.['en-US']
      || value?.en
      || value?.default
      || value?.['zh-CN']
      || fallback
  }

  function profileAssignedOutputs(profile: TrainerEngineProfile): SupportedEngineOutputId[] {
    return SUPPORTED_ENGINE_OUTPUTS.value
      .map((output) => output.id)
      .filter((outputId) => settingsDraft.engines.outputAssignments[outputId] === profile.id)
  }

  function profileLoadOutputs(profile: TrainerEngineProfile): SupportedEngineOutputId[] {
    const assigned = profileAssignedOutputs(profile)
    if (assigned.length) return assigned
    return supportedOutputsForProfile(profile).map((output) => output.id)
  }

  function assignSupportedOutputsForLoading(profile: TrainerEngineProfile) {
    if (profileAssignedOutputs(profile).length) return
    for (const outputId of profileLoadOutputs(profile)) {
      settingsDraft.engines.outputAssignments[outputId] = profile.id
    }
  }

  function setEngineOutputAssignment(outputId: SupportedEngineOutputId, event: Event) {
    const profile = activeEngineProfile.value
    if (!profile || profileConfigurationLocked(profile)) return
    const checked = (event.target as HTMLInputElement).checked
    settingsDraft.engines.outputAssignments[outputId] = checked ? profile.id : ''
  }

  function engineWeight(profile: TrainerEngineProfile, slotId: string) {
    return (profile.weights || []).find((weight) => weight.slotId === slotId)
  }

  function weightSlotIsActive(
    slot: TrainerEngineDescription['weightSlots'][number],
    profile: TrainerEngineProfile,
    outputIds = profileAssignedOutputs(profile),
  ): boolean {
    const required = slot.requiredForOutputs || []
    if (!required.length) return true
    const assigned = new Set(outputIds)
    return required.some((output) => assigned.has(output.id as SupportedEngineOutputId))
  }

  function requiredWeightsReady(profile: TrainerEngineProfile, outputIds = profileAssignedOutputs(profile)): boolean {
    return weightSlotsForProfile(profile)
      .filter((slot) => weightSlotIsActive(slot, profile, outputIds))
      .every((slot) => {
        const weight = engineWeight(profile, slot.id)
        return Boolean(weight?.path && weight.format)
      })
  }

  function setEngineDevice(event: Event) {
    const profile = activeEngineProfile.value
    if (!profile || profileConfigurationLocked(profile)) return
    profile.device = (event.target as HTMLSelectElement).value
  }

  function formatEngineOptionDefault(value: unknown): string {
    if (value === true) return t('common.yes')
    if (value === false) return t('common.no')
    return value == null ? t('engine.settingFallback') : String(value)
  }

  function engineOptionInputMode(option: typeof activeEngineOptionEntries.value[number]) {
    if (option.type === 'integer') return 'numeric'
    if (option.type === 'number') return 'decimal'
    return undefined
  }

  function setEngineOptionFromEvent(option: typeof activeEngineOptionEntries.value[number], event: Event) {
    const profile = activeEngineProfile.value
    if (!profile || profileConfigurationLocked(profile)) return
    const target = event.target as HTMLInputElement | HTMLSelectElement
    const raw = target.value
    if (raw === '') {
      delete profile.options[option.key]
      engineSaveMessage.value = ''
      return
    }
    if (option.type === 'boolean') profile.options[option.key] = raw === 'true'
    else if (option.type === 'number' || option.type === 'integer') {
      const value = Number(raw)
      const invalid = !Number.isFinite(value)
        || (option.type === 'integer' && !Number.isInteger(value))
        || (option.minimum !== undefined && value < option.minimum)
        || (option.maximum !== undefined && value > option.maximum)
      if (invalid) {
        target.value = String(profile.options[option.key] ?? '')
        engineSaveMessage.value = t('engine.optionInvalid', { label: option.label })
        return
      }
      profile.options[option.key] = value
    } else profile.options[option.key] = raw
  }

  function replaceEngineDraft(engines: TrainerEngineSettings) {
    suppressEngineAutosave = true
    try {
      Object.assign(settingsDraft.engines, cloneEngineSettings(engines))
    } finally {
      suppressEngineAutosave = false
    }
  }

  function cancelEngineAutosaveTimer() {
    if (engineAutosaveTimer === null) return
    window.clearTimeout(engineAutosaveTimer)
    engineAutosaveTimer = null
  }

  function scheduleEngineAutosave(delay = ENGINE_AUTOSAVE_DELAY_MS) {
    cancelEngineAutosaveTimer()
    if (loadingEngineProfileId.value || unloadingEngineProfileId.value) return
    engineAutosaveTimer = window.setTimeout(() => {
      engineAutosaveTimer = null
      void flushEngineAutosave()
    }, delay)
  }

  watch(
    () => settingsDraft.engines,
    () => {
      if (suppressEngineAutosave || !engineAutosaveEnabled) return
      engineSaves.changed()
      engineSaveMessage.value = ''
      scheduleEngineAutosave()
    },
    { deep: true, flush: 'sync' },
  )

  async function saveEngineDraftSnapshot(snapshot: TrainerEngineSettings, revision: number): Promise<boolean> {
    if (!window.trainerAPI) return false
    try {
      const saved = await window.trainerAPI.saveSettings({ engines: snapshot })
      applySettings(mergeSettingsReply(settings, saved, { engines: snapshot }))
      if (engineSaves.revision === revision) replaceEngineDraft(saved.engines)
      return true
    } catch (error) {
      engineSaveMessage.value = t('engine.saveFailed', {
        message: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  function flushEngineAutosave(): Promise<boolean> {
    cancelEngineAutosaveTimer()
    return engineSaves.flush()
  }

  async function loadEngineProfile(profileId: string) {
    if (!window.trainerAPI?.activateEngine || loadingEngineProfileId.value || unloadingEngineProfileId.value) return
    const profile = activeEngineProfiles.value.find((item) => item.id === profileId)
    if (!profile) return
    loadingEngineProfileId.value = profileId
    engineSaveMessage.value = ''
    delete engineLoadErrors[profileId]
    try {
      assignSupportedOutputsForLoading(profile)
      if (!await flushEngineAutosave()) return
      const activationRevision = engineSaves.revision
      const engines = cloneEngineSettings(settingsDraft.engines)
      const loaded = await window.trainerAPI.activateEngine({ profileId, engines })
      applySettings(mergeSettingsReply(settings, loaded, { engines: loaded.engines }))
      applyStatus(await window.trainerAPI.getStatus())
      captureRuntimeEngineProfile('decision', loaded.engines)
      captureRuntimeEngineProfile('opponent', loaded.engines)
      engineSaves.acknowledge(activationRevision)
      if (engineSaves.revision === activationRevision) replaceEngineDraft(loaded.engines)
      engineSaveMessage.value = t('engine.loaded')
    } catch (error) {
      try {
        const failedSettings = await window.trainerAPI.getSettings()
        applySettings(mergeSettingsReply(settings, failedSettings, { engines: failedSettings.engines }))
        applyStatus(await window.trainerAPI.getStatus())
        captureRuntimeEngineProfile('decision', failedSettings.engines)
        captureRuntimeEngineProfile('opponent', failedSettings.engines)
      } catch {
        // Keep the original load error when status synchronization also fails.
      }
      engineLoadErrors[profileId] = error instanceof Error ? error.message : String(error)
      engineSaveMessage.value = t('engine.loadFailed', { message: engineLoadErrors[profileId] })
    } finally {
      loadingEngineProfileId.value = ''
      if (engineSaves.pending) scheduleEngineAutosave(0)
    }
  }

  async function unloadEngineProfile(profileId: string) {
    if (!window.trainerAPI?.unloadEngine || loadingEngineProfileId.value || unloadingEngineProfileId.value) return
    if (activeEngineProfile.value?.id !== profileId || !profileIsLoaded(activeEngineProfile.value)) return
    const profile = activeEngineProfile.value
    unloadingEngineProfileId.value = profileId
    engineSaveMessage.value = ''
    try {
      if (!await flushEngineAutosave()) return
      const unloadRevision = engineSaves.revision
      const unloaded = await window.trainerAPI.unloadEngine({ profileId })
      applyStatus(unloaded.state)
      applySettings(mergeSettingsReply(settings, unloaded.settings, { engines: unloaded.settings.engines }))
      if (engineSaves.revision === unloadRevision) replaceEngineDraft(unloaded.settings.engines)
      if (profileAssignedOutputs(profile).some((output) => output !== 'action-recommendation')) {
        await afterOpponentUnload()
      }
      engineSaveMessage.value = t('engine.unloaded')
    } catch (error) {
      engineSaveMessage.value = t('engine.unloadFailed', {
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      unloadingEngineProfileId.value = ''
      if (engineSaves.pending) scheduleEngineAutosave(0)
    }
  }

  const engineStatusItems = computed(() => buildEngineStatusItems({
    profiles: settings.engines.profiles,
    status,
    loadingProfileId: loadingEngineProfileId.value,
    loadErrors: engineLoadErrors,
    runtimeState: profileRuntimeState,
    runtimeKinds: profileRuntimeKinds,
    t,
  }))
  onBeforeUnmount(() => {
    cancelEngineAutosaveTimer()
    if (deleteEngineConfirmationTimer !== null) {
      window.clearTimeout(deleteEngineConfirmationTimer)
      deleteEngineConfirmationTimer = null
    }
  })

  return {
    SUPPORTED_ENGINE_OUTPUTS,
    activeCatalogEngine,
    activeEngineDevices,
    activeEngineOptionEntries,
    activeEngineProfile,
    activeEngineProfileIndex,
    activeEngineProfiles,
    activeEngineWeightSlots,
    activeSupportedOutputs,
    addEngineProfile,
    captureRuntimeEngineProfile,
    chooseEngineFile,
    chooseEngineWeight,
    closeEngineWindow,
    deleteEngineConfirmationId,
    deleteEngineProfile,
    describingEngineIds,
    duplicateEngineProfile,
    engineCatalogDiagnostics,
    engineDescribeErrors,
    engineDescriptionKey,
    engineFooterMessage,
    engineLoadErrors,
    engineOptionInputMode,
    engineOutputAssignmentHasError,
    engineOutputAssignmentIsLoaded,
    engineOutputAssignmentIsLoading,
    engineOutputFilter,
    engineProfileClasses,
    engineProfileSubtitle,
    engineSaveMessage,
    engineStatusItems,
    engineWeight,
    filteredEngineProfiles,
    flushEngineAutosave,
    formatEngineOptionDefault,
    handleEngineProfileAction,
    loadingEngineProfileId,
    localizedEngineText,
    markConfiguredEngineStarting,
    moveEngineProfile,
    openEngineWindow,
    profileAssignedOutputs,
    profileConfigurationLocked,
    profileIsLoaded,
    selectEngineProfile,
    setEngineDevice,
    setEngineOptionFromEvent,
    setEngineOutputAssignment,
    setEngineProfileName,
    shouldShowEngineActionButton,
    showEngineWindow,
    suggestedEngineProfileName,
    toggleEngineOutputFilter,
    unloadingEngineProfileId,
  }
}
