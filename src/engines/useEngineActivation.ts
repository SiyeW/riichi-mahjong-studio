import { computed, reactive, ref, type Ref } from 'vue'
import type { DesktopBridge } from '../contracts/desktopBridge.ts'
import type { EngineProfile } from '../contracts/engines.ts'
import type { StudioSettings } from '../contracts/settings.ts'
import type { StudioStatus } from '../contracts/runtime.ts'
import type { TranslationParams } from '../i18n.ts'
import { buildEngineStatusItems, type EngineRuntimeKind } from './engineStatusItems.ts'
import { mergeSettingsReply } from '../settingsChanges.ts'
import { useEngineRuntimeProfiles } from './useEngineRuntimeProfiles.ts'
import type { SupportedEngineOutputId } from './useEngineCatalog.ts'
import type { useEngineSettingsDraft } from './useEngineSettingsDraft.ts'

type Translate = (key: string, params?: TranslationParams) => string
type EngineSettingsDraft = ReturnType<typeof useEngineSettingsDraft>

export function createEngineActivationState() {
  return {
    loadingProfileId: ref(''),
    unloadingProfileId: ref(''),
    loadErrors: reactive<Record<string, string>>({}),
  }
}

interface EngineActivationOptions {
  bridge: () => DesktopBridge | undefined
  settings: StudioSettings
  settingsDraft: StudioSettings
  status: StudioStatus
  profiles: Readonly<Ref<EngineProfile[]>>
  activeProfile: Readonly<Ref<EngineProfile | null>>
  opponentOutputIds: readonly string[]
  draft: EngineSettingsDraft
  t: Translate
  applySettings: (settings: StudioSettings) => void
  applyStatus: (status: StudioStatus) => void
  afterOpponentUnload: () => void | Promise<void>
  assignedOutputs: (profile: EngineProfile) => SupportedEngineOutputId[]
  loadOutputs: (profile: EngineProfile) => SupportedEngineOutputId[]
  assignOutputsForLoading: (profile: EngineProfile) => void
  requiredWeightsReady: (
    profile: EngineProfile,
    outputIds?: SupportedEngineOutputId[],
  ) => boolean
}

export function useEngineActivation(
  options: EngineActivationOptions,
  state = createEngineActivationState(),
) {
  const runtime = useEngineRuntimeProfiles({
    status: options.status,
    opponentOutputIds: [...options.opponentOutputIds],
    assignedOutputs: options.assignedOutputs,
  })

  function profileIsLoaded(profile: EngineProfile): boolean {
    const runtimeGroups = runtime.profileRuntimeKinds(profile)
    return runtimeGroups.length > 0 && runtimeGroups.every((kind) => (
      runtime.profileRuntimeState(profile, kind)?.ready === true
    ))
  }

  function profileIsLoading(profile: EngineProfile): boolean {
    if (state.loadErrors[profile.id]) return false
    if (profile.id === state.loadingProfileId.value) return true
    return runtime.profileRuntimeKinds(profile).some((kind) => {
      const runtimeState = runtime.profileRuntimeState(profile, kind)
      return runtimeState !== null
        && !runtimeState.ready
        && !runtimeState.unloaded
        && !runtime.runtimeEngineError(kind, profile)
    })
  }

  function profileConfigurationLocked(profile: EngineProfile): boolean {
    return profileIsLoaded(profile) || profileIsLoading(profile)
  }

  function outputRuntimeKind(outputId: SupportedEngineOutputId): EngineRuntimeKind {
    return outputId === 'action-recommendation' ? 'decision' : 'opponent'
  }

  function outputAssignmentProfile(outputId: SupportedEngineOutputId): EngineProfile | null {
    const profileId = options.settingsDraft.engines.outputAssignments[outputId]
    return options.profiles.value.find((profile) => profile.id === profileId) || null
  }

  function outputAssignmentIsLoaded(outputId: SupportedEngineOutputId): boolean {
    const profile = outputAssignmentProfile(outputId)
    return Boolean(profile && runtime.profileRuntimeState(profile, outputRuntimeKind(outputId))?.ready)
  }

  function outputAssignmentHasError(outputId: SupportedEngineOutputId): boolean {
    const profile = outputAssignmentProfile(outputId)
    if (!profile) return false
    const kind = outputRuntimeKind(outputId)
    return Boolean(state.loadErrors[profile.id])
      || (runtime.profileMatchesRuntime(profile, kind) && Boolean(runtime.runtimeEngineError(kind, profile)))
  }

  function outputAssignmentIsLoading(outputId: SupportedEngineOutputId): boolean {
    const profile = outputAssignmentProfile(outputId)
    if (!profile || outputAssignmentIsLoaded(outputId) || outputAssignmentHasError(outputId)) return false
    if (state.loadingProfileId.value === profile.id) return true
    const runtimeState = runtime.profileRuntimeState(profile, outputRuntimeKind(outputId))
    return Boolean(runtimeState && !runtimeState.ready && !runtimeState.unloaded)
  }

  function profileClasses(profile: EngineProfile, selected: boolean) {
    const runtimeGroups = runtime.profileRuntimeKinds(profile)
    const loaded = profileIsLoaded(profile)
    const matchesRuntime = runtimeGroups.some((kind) => runtime.profileMatchesRuntime(profile, kind))
    return {
      selected,
      loaded,
      loading: profileIsLoading(profile),
      unloaded: matchesRuntime && runtimeGroups.every((kind) => (
        runtime.profileRuntimeState(profile, kind)?.unloaded === true
      )),
      error: Boolean(state.loadErrors[profile.id])
        || runtimeGroups.some((kind) => (
          runtime.profileMatchesRuntime(profile, kind)
          && Boolean(runtime.runtimeEngineError(kind, profile))
        )),
      unavailable: !profile.enginePath || options.assignedOutputs(profile).length === 0,
    }
  }

  function profileSubtitle(profile: EngineProfile): string {
    // The state alone cannot tell two builds of one engine apart, which is the
    // first thing to know when a profile stops loading after a rebuild.
    const version = String(profile.engineVersion || '').trim()
    const withVersion = (state: string) => (version ? `${state} · ${version}` : state)
    if (profile.id === state.loadingProfileId.value) return withVersion(options.t('engine.status.loading'))
    if (state.loadErrors[profile.id]) return withVersion(options.t('engine.status.failed'))
    const runtimeGroups = runtime.profileRuntimeKinds(profile)
    if (!runtimeGroups.some((kind) => runtime.profileMatchesRuntime(profile, kind))) return version
    if (runtimeGroups.some((kind) => runtime.runtimeEngineError(kind, profile))) {
      return withVersion(options.t('engine.status.failed'))
    }
    if (runtimeGroups.every((kind) => runtime.profileRuntimeState(profile, kind)?.unloaded === true)) {
      return withVersion(options.t('engine.status.notLoaded'))
    }
    if (!profileIsLoaded(profile)) return withVersion(options.t('engine.status.loading'))
    return withVersion(options.t('engine.status.loaded'))
  }

  function profileError(profile: EngineProfile | null): string {
    return profile
      ? runtime.profileRuntimeKinds(profile)
        .filter((kind) => runtime.profileMatchesRuntime(profile, kind))
        .map((kind) => runtime.runtimeEngineError(kind, profile))
        .find(Boolean) || ''
      : ''
  }

  function shouldShowActionButton(profile: EngineProfile): boolean {
    const outputIds = options.loadOutputs(profile)
    return profileIsLoaded(profile)
      || (!profileIsLoading(profile)
        && Boolean(profile.enginePath && outputIds.length)
        && options.requiredWeightsReady(profile, outputIds))
  }

  async function load(profileId: string) {
    const bridge = options.bridge()
    if (!bridge?.activateEngine || state.loadingProfileId.value || state.unloadingProfileId.value) return
    const profile = options.profiles.value.find((item) => item.id === profileId)
    if (!profile) return
    state.loadingProfileId.value = profileId
    options.draft.message.value = ''
    delete state.loadErrors[profileId]
    try {
      options.assignOutputsForLoading(profile)
      if (!await options.draft.flush()) return
      const activationRevision = options.draft.currentRevision()
      const engines = options.draft.snapshot()
      const loaded = await bridge.activateEngine({ profileId, engines })
      options.applySettings(mergeSettingsReply(options.settings, loaded, { engines: loaded.engines }))
      options.applyStatus(await bridge.getStatus())
      runtime.captureRuntimeEngineProfile('decision', loaded.engines)
      runtime.captureRuntimeEngineProfile('opponent', loaded.engines)
      options.draft.acknowledge(activationRevision)
      options.draft.replaceIfCurrent(activationRevision, loaded.engines)
      options.draft.message.value = options.t('engine.loaded')
    } catch (error) {
      try {
        const failedSettings = await bridge.getSettings()
        options.applySettings(mergeSettingsReply(
          options.settings,
          failedSettings,
          { engines: failedSettings.engines },
        ))
        options.applyStatus(await bridge.getStatus())
        runtime.captureRuntimeEngineProfile('decision', failedSettings.engines)
        runtime.captureRuntimeEngineProfile('opponent', failedSettings.engines)
      } catch {
        // Keep the original load error when status synchronization also fails.
      }
      state.loadErrors[profileId] = error instanceof Error ? error.message : String(error)
      options.draft.message.value = options.t('engine.loadFailed', { message: state.loadErrors[profileId] })
    } finally {
      state.loadingProfileId.value = ''
      options.draft.schedulePending()
    }
  }

  async function unload(profileId: string) {
    const bridge = options.bridge()
    if (!bridge?.unloadEngine || state.loadingProfileId.value || state.unloadingProfileId.value) return
    const profile = options.activeProfile.value
    if (profile?.id !== profileId || !profileIsLoaded(profile)) return
    state.unloadingProfileId.value = profileId
    options.draft.message.value = ''
    try {
      if (!await options.draft.flush()) return
      const unloadRevision = options.draft.currentRevision()
      const unloaded = await bridge.unloadEngine({ profileId })
      options.applyStatus(unloaded.state)
      options.applySettings(mergeSettingsReply(
        options.settings,
        unloaded.settings,
        { engines: unloaded.settings.engines },
      ))
      options.draft.replaceIfCurrent(unloadRevision, unloaded.settings.engines)
      if (options.assignedOutputs(profile).some((output) => output !== 'action-recommendation')) {
        await options.afterOpponentUnload()
      }
      options.draft.message.value = options.t('engine.unloaded')
    } catch (error) {
      options.draft.message.value = options.t('engine.unloadFailed', {
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      state.unloadingProfileId.value = ''
      options.draft.schedulePending()
    }
  }

  function handleProfileAction(profileId: string) {
    const profile = options.profiles.value.find((item) => item.id === profileId)
    if (!profile) return
    if (profileIsLoaded(profile)) void unload(profile.id)
    else void load(profile.id)
  }

  const statusItems = computed(() => buildEngineStatusItems({
    profiles: options.settings.engines.profiles,
    status: options.status,
    loadingProfileId: state.loadingProfileId.value,
    loadErrors: state.loadErrors,
    runtimeState: runtime.profileRuntimeState,
    runtimeKinds: runtime.profileRuntimeKinds,
    t: options.t,
  }))

  return {
    ...runtime,
    ...state,
    handleProfileAction,
    load,
    outputAssignmentHasError,
    outputAssignmentIsLoaded,
    outputAssignmentIsLoading,
    profileClasses,
    profileConfigurationLocked,
    profileError,
    profileIsLoaded,
    profileIsLoading,
    profileSubtitle,
    shouldShowActionButton,
    statusItems,
    unload,
  }
}
