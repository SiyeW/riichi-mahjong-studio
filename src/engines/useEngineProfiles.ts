import { computed, onScopeDispose, reactive, ref, watch, type Ref } from 'vue'
import type { TranslationParams } from '../i18n.ts'
import { useEngineSettingsDraft } from './useEngineSettingsDraft.ts'
import { createEngineActivationState, useEngineActivation } from './useEngineActivation.ts'
import {
  OPPONENT_ENGINE_OUTPUT_IDS,
  useEngineCatalog,
  type SupportedEngineOutputId,
} from './useEngineCatalog.ts'
import type { EngineDescription, EngineProfile } from '../contracts/engines.ts'
import type { StudioSettings } from '../contracts/settings.ts'
import type { StudioStatus } from '../contracts/runtime.ts'
import type { DesktopBridge } from '../contracts/desktopBridge.ts'
import type {
  EngineOutputFilterItem,
  EngineProfileDetailView,
  EngineProfileListItem,
} from './presentation.ts'

export type { SupportedEngineOutputId } from './useEngineCatalog.ts'
export type {
  EngineOutputFilterItem,
  EngineProfileDetailView,
  EngineProfileListItem,
} from './presentation.ts'

type Translate = (key: string, params?: TranslationParams) => string

interface UseEngineProfilesOptions {
  bridge: () => DesktopBridge | undefined
  settings: StudioSettings
  settingsDraft: StudioSettings
  status: StudioStatus
  locale: Readonly<Ref<string>>
  t: Translate
  closeSettingsPanel: () => void
  focus: () => void
  applySettings: (settings: StudioSettings) => void
  applyStatus: (status: StudioStatus) => void
  afterOpponentUnload: () => void | Promise<void>
}

const DELETE_CONFIRMATION_TIMEOUT_MS = 3000

export function useEngineProfiles(options: UseEngineProfilesOptions) {
  const {
    bridge,
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

  const showEngineWindow = ref(false)
  const activationState = createEngineActivationState()
  const {
    loadingProfileId: loadingEngineProfileId,
    unloadingProfileId: unloadingEngineProfileId,
    loadErrors: engineLoadErrors,
  } = activationState
  const deleteEngineConfirmationId = ref('')
  const engineOutputFilter = ref<SupportedEngineOutputId | null>(null)
  const editingEngineProfileId = ref('')
  let deleteEngineConfirmationTimer: ReturnType<typeof setTimeout> | null = null
  const engineDraft = useEngineSettingsDraft({
    settings,
    settingsDraft,
    busy: computed(() => Boolean(loadingEngineProfileId.value || unloadingEngineProfileId.value)),
    t,
    applySettings,
    save: (engines) => bridge()?.saveSettings({ engines }),
  })
  const engineSaveMessage = engineDraft.message
  const engineCatalog = useEngineCatalog({ bridge, settings, locale, t })
  const {
    catalogEngineForProfile,
    describeErrors: engineDescribeErrors,
    describingKeys: describingEngineIds,
    descriptionForProfile,
    descriptionKey: engineDescriptionKey,
    diagnostics: engineCatalogDiagnostics,
    localizedText: localizedEngineText,
    optionEntriesForProfile,
    supportedOutputs: SUPPORTED_ENGINE_OUTPUTS,
    supportedOutputsForProfile,
    weightSlotsForProfile,
  } = engineCatalog

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
  const activeCatalogEngine = computed(() => (
    catalogEngineForProfile(activeEngineProfile.value)
  ))
  const activeEngineDescription = computed(() => (
    descriptionForProfile(activeEngineProfile.value)
  ))

  const activeSupportedOutputs = computed(() => {
    const profile = activeEngineProfile.value
    return profile ? supportedOutputsForProfile(profile) : []
  })

  const activeEngineWeightSlots = computed(() => {
    const profile = activeEngineProfile.value
    return profile ? weightSlotsForProfile(profile) : []
  })
  const activeEngineDevices = computed(() => activeEngineDescription.value?.devices || [])
  const activeEngineOptionEntries = computed(() => optionEntriesForProfile(activeEngineProfile.value))

  function openEngineWindow() {
    engineDraft.beginEditing()
    closeSettingsPanel()
    showEngineWindow.value = true
    engineSaveMessage.value = ''
    deleteEngineConfirmationId.value = ''
    if (!settingsDraft.engines.profiles.some((profile) => profile.id === editingEngineProfileId.value)) {
      editingEngineProfileId.value = settingsDraft.engines.profiles[0]?.id || ''
    }
    // The dialog describes live: a cached description would keep showing the
    // engine build that was current the last time this session asked.
    for (const profile of activeEngineProfiles.value) {
      void describeEngineProfile(profile, { force: true })
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
      clearTimeout(deleteEngineConfirmationTimer)
      deleteEngineConfirmationTimer = null
    }
    if (!profileId) return
    deleteEngineConfirmationTimer = setTimeout(() => {
      if (deleteEngineConfirmationId.value === profileId) {
        deleteEngineConfirmationId.value = ''
      }
    }, DELETE_CONFIRMATION_TIMEOUT_MS)
  })

  function engineProfileSupportsOutput(
    profile: EngineProfile,
    outputId: SupportedEngineOutputId,
  ): boolean {
    return supportedOutputsForProfile(profile).some(({ id }) => id === outputId)
  }

  async function describeEngineProfile(profile: EngineProfile | null, options: { force?: boolean } = {}) {
    const description = await engineCatalog.describe(profile, options)
    if (!profile || !description || profileConfigurationLocked(profile)) return
    profile.engineId = description.engine.id
    profile.engineVersion = description.engine.version
    if (!profile.device || !description.devices.some((device) => device.type === profile.device)) {
      profile.device = description.devices[0]?.type || ''
    }
  }

  const {
    captureRuntimeEngineProfile,
    handleProfileAction: handleEngineProfileAction,
    outputAssignmentHasError: engineOutputAssignmentHasError,
    outputAssignmentIsLoaded: engineOutputAssignmentIsLoaded,
    outputAssignmentIsLoading: engineOutputAssignmentIsLoading,
    markConfiguredEngineStarting,
    profileClasses: runtimeProfileClasses,
    profileConfigurationLocked,
    profileError,
    profileIsLoaded,
    profileSubtitle: engineProfileSubtitle,
    shouldShowActionButton: shouldShowEngineActionButton,
    statusItems: engineStatusItems,
  } = useEngineActivation({
    bridge,
    settings,
    settingsDraft,
    status,
    profiles: activeEngineProfiles,
    activeProfile: activeEngineProfile,
    opponentOutputIds: OPPONENT_ENGINE_OUTPUT_IDS,
    draft: engineDraft,
    t,
    applySettings,
    applyStatus,
    afterOpponentUnload,
    assignedOutputs: profileAssignedOutputs,
    loadOutputs: profileLoadOutputs,
    assignOutputsForLoading: assignSupportedOutputsForLoading,
    requiredWeightsReady,
  }, activationState)

  function engineProfileClasses(profile: EngineProfile) {
    return runtimeProfileClasses(profile, profile.id === activeEngineProfile.value?.id)
  }

  const engineFooterMessage = computed(() => {
    return profileError(activeEngineProfile.value) || engineSaveMessage.value
  })

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
    const copyProfile: EngineProfile = JSON.parse(JSON.stringify(source))
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
    const profile: EngineProfile = {
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

  function suggestedEngineProfileName(profile: EngineProfile): string {
    const engineName = descriptionForProfile(profile)?.engine.name
      || catalogEngineForProfile(profile)?.name
      || fileNameFromPath(profile.enginePath).replace(/\.[^.]+$/, '')
    const weightNames = (profile.weights || [])
      .map((weight) => fileNameFromPath(weight.path).replace(/\.[^.]+$/, ''))
      .filter(Boolean)
    return [engineName, ...weightNames].filter(Boolean).join(' + ')
  }

  function refreshAutomaticEngineName(profile: EngineProfile) {
    if (profile.autoName !== false && !profile.builtIn) profile.name = suggestedEngineProfileName(profile)
  }

  function setEngineProfileNameValue(value: string) {
    const profile = activeEngineProfile.value
    if (!profile || profileConfigurationLocked(profile)) return
    profile.name = value
    profile.autoName = !value.trim()
    if (profile.autoName) refreshAutomaticEngineName(profile)
  }

  async function chooseEngineFile() {
    const profile = activeEngineProfile.value
    const currentBridge = bridge()
    if (!profile || profileConfigurationLocked(profile) || !currentBridge?.chooseEngineFile) return
    const selectedPath = await currentBridge.chooseEngineFile()
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
    // Picking a file means "read this engine again", so the cached description
    // of that path must not answer for it.
    await describeEngineProfile(profile, { force: true })
    refreshAutomaticEngineName(profile)
  }

  async function chooseEngineWeight(slotId: string) {
    const profile = activeEngineProfile.value
    const currentBridge = bridge()
    if (!profile || profileConfigurationLocked(profile) || !currentBridge?.chooseEngineWeight) return
    const selectedPath = await currentBridge.chooseEngineWeight()
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

  function profileAssignedOutputs(profile: EngineProfile): SupportedEngineOutputId[] {
    return SUPPORTED_ENGINE_OUTPUTS.value
      .map((output) => output.id)
      .filter((outputId) => settingsDraft.engines.outputAssignments[outputId] === profile.id)
  }

  function profileLoadOutputs(profile: EngineProfile): SupportedEngineOutputId[] {
    const assigned = profileAssignedOutputs(profile)
    if (assigned.length) return assigned
    return supportedOutputsForProfile(profile).map((output) => output.id)
  }

  function assignSupportedOutputsForLoading(profile: EngineProfile) {
    if (profileAssignedOutputs(profile).length) return
    for (const outputId of profileLoadOutputs(profile)) {
      settingsDraft.engines.outputAssignments[outputId] = profile.id
    }
  }

  function setEngineOutputAssignmentValue(outputId: SupportedEngineOutputId, checked: boolean) {
    const profile = activeEngineProfile.value
    if (!profile || profileConfigurationLocked(profile)) return
    settingsDraft.engines.outputAssignments[outputId] = checked ? profile.id : ''
  }

  function engineWeight(profile: EngineProfile, slotId: string) {
    return (profile.weights || []).find((weight) => weight.slotId === slotId)
  }

  function weightSlotIsActive(
    slot: EngineDescription['weightSlots'][number],
    profile: EngineProfile,
    outputIds = profileAssignedOutputs(profile),
  ): boolean {
    const required = slot.requiredForOutputs || []
    if (!required.length) return true
    const assigned = new Set(outputIds)
    return required.some((output) => assigned.has(output.id as SupportedEngineOutputId))
  }

  function requiredWeightsReady(profile: EngineProfile, outputIds = profileAssignedOutputs(profile)): boolean {
    return weightSlotsForProfile(profile)
      .filter((slot) => weightSlotIsActive(slot, profile, outputIds))
      .every((slot) => {
        const weight = engineWeight(profile, slot.id)
        return Boolean(weight?.path && weight.format)
      })
  }

  function setEngineDeviceValue(value: string) {
    const profile = activeEngineProfile.value
    if (!profile || profileConfigurationLocked(profile)) return
    profile.device = value
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

  function setEngineOptionValue(optionKey: string, raw: string) {
    const option = activeEngineOptionEntries.value.find((entry) => entry.key === optionKey)
    const profile = activeEngineProfile.value
    if (!option || !profile || profileConfigurationLocked(profile)) return
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
        engineSaveMessage.value = t('engine.optionInvalid', { label: option.label })
        return
      }
      profile.options[option.key] = value
    } else profile.options[option.key] = raw
  }

  function flushEngineAutosave(): Promise<boolean> {
    return engineDraft.flush()
  }

  const engineOutputFilterItems = computed<EngineOutputFilterItem[]>(() => (
    SUPPORTED_ENGINE_OUTPUTS.value.map((output) => ({
      ...output,
      assigned: Boolean(settingsDraft.engines.outputAssignments[output.id]),
      loaded: engineOutputAssignmentIsLoaded(output.id),
      loading: engineOutputAssignmentIsLoading(output.id),
      error: engineOutputAssignmentHasError(output.id),
      selected: engineOutputFilter.value === output.id,
    }))
  ))
  const engineProfileListItems = computed<EngineProfileListItem[]>(() => (
    filteredEngineProfiles.value.map((profile) => ({
      id: profile.id,
      name: profile.name,
      subtitle: engineProfileSubtitle(profile),
      classes: engineProfileClasses(profile),
      showAction: shouldShowEngineActionButton(profile),
      loaded: profileIsLoaded(profile),
    }))
  ))
  const engineListCanMoveUp = computed(() => activeEngineProfileIndex.value > 0)
  const engineListCanMoveDown = computed(() => (
    activeEngineProfileIndex.value >= 0
    && activeEngineProfileIndex.value < activeEngineProfiles.value.length - 1
  ))
  const engineListCanDuplicate = computed(() => Boolean(activeEngineProfile.value))
  const engineListCanDelete = computed(() => Boolean(
    activeEngineProfile.value
    && !activeEngineProfile.value.builtIn
    && profileAssignedOutputs(activeEngineProfile.value).length === 0
  ))
  const engineListDeleteConfirmation = computed(() => (
    deleteEngineConfirmationId.value === activeEngineProfile.value?.id
  ))
  const activeEngineProfileDetail = computed<EngineProfileDetailView | null>(() => {
    const profile = activeEngineProfile.value
    if (!profile) return null
    const key = engineDescriptionKey(profile)
    const locked = profileConfigurationLocked(profile)
    const catalog = activeCatalogEngine.value
    return {
      id: profile.id,
      name: profile.name,
      suggestedName: suggestedEngineProfileName(profile),
      locked,
      enginePath: profile.enginePath,
      outputs: activeSupportedOutputs.value.map((output) => ({
        ...output,
        assigned: settingsDraft.engines.outputAssignments[output.id] === profile.id,
      })),
      unsupportedOutputs: Boolean(profile.enginePath && !activeSupportedOutputs.value.length && !describingEngineIds.has(key)),
      weights: activeEngineWeightSlots.value.map((slot) => ({
        id: slot.id,
        label: localizedEngineText(slot.title, slot.id),
        path: engineWeight(profile, slot.id)?.path || '',
      })),
      devices: activeEngineDevices.value.map((device) => ({
        type: device.type,
        label: localizedEngineText(device.title, device.type),
      })),
      device: profile.device,
      licenses: catalog?.licenses || [],
      notices: catalog?.notices || [],
      sourceUrl: catalog?.sourceUrl || '',
      readingOptions: Boolean(profile.enginePath && describingEngineIds.has(key)),
      options: activeEngineOptionEntries.value.map((option) => ({
        key: option.key,
        label: option.label,
        type: option.type,
        enumValues: option.enumValues,
        value: typeof profile.options[option.key] === 'string'
          || typeof profile.options[option.key] === 'number'
          || typeof profile.options[option.key] === 'boolean'
          ? profile.options[option.key] as string | number | boolean
          : '',
        defaultLabel: t('engine.defaultOption', { value: formatEngineOptionDefault(option.defaultValue) }),
        placeholder: String(option.defaultValue ?? ''),
        inputMode: engineOptionInputMode(option),
      })),
      describeError: engineDescribeErrors[key]
        ? t('engine.optionsFailed', { message: engineDescribeErrors[key] })
        : '',
      catalogDiagnostic: engineCatalogDiagnostics.value.length
        ? t('engine.packageDiagnostic', { message: engineCatalogDiagnostics.value[0].message })
        : '',
    }
  })
  onScopeDispose(() => {
    if (deleteEngineConfirmationTimer !== null) {
      clearTimeout(deleteEngineConfirmationTimer)
      deleteEngineConfirmationTimer = null
    }
  })

  return {
    activeCatalogEngine,
    activeEngineProfileDetail,
    addEngineProfile,
    captureRuntimeEngineProfile,
    chooseEngineFile,
    chooseEngineWeight,
    closeEngineWindow,
    deleteEngineProfile,
    duplicateEngineProfile,
    engineFooterMessage,
    engineOutputFilterItems,
    engineProfileListItems,
    engineSaveMessage,
    engineStatusItems,
    engineListCanDelete,
    engineListCanDuplicate,
    engineListCanMoveDown,
    engineListCanMoveUp,
    engineListDeleteConfirmation,
    flushEngineAutosave,
    handleEngineProfileAction,
    loadingEngineProfileId,
    localizedEngineText,
    markConfiguredEngineStarting,
    moveEngineProfile,
    openEngineWindow,
    selectEngineProfile,
    setEngineDeviceValue,
    setEngineOptionValue,
    setEngineProfileNameValue,
    setEngineOutputAssignmentValue,
    showEngineWindow,
    toggleEngineOutputFilter,
    unloadingEngineProfileId,
  }
}
