import { reactive } from 'vue'
import type { EngineRuntimeKind } from './engineStatusItems'
import type { EngineProfile, EngineSettings, ModelRuntimeState } from './contracts/engines'

export function useEngineRuntimeProfiles(options: {
  status: TrainerStatusSnapshot
  opponentOutputIds: string[]
  assignedOutputs: (profile: EngineProfile) => string[]
}) {
  const { status, opponentOutputIds, assignedOutputs } = options
  const runtimeProfiles = reactive<Record<string, EngineProfile>>({})

  function runtimeState(kind: EngineRuntimeKind): ModelRuntimeState {
    return kind === 'opponent'
      ? status.modelRuntime.opponentAnalysis
      : status.modelRuntime.decision
  }

  function runtimeError(kind: EngineRuntimeKind, profile: EngineProfile | null = null): string {
    if (kind === 'opponent') {
      if (profile) return String(runtimeState(kind).profiles?.[profile.id]?.error || '')
      return String(status.modelActivity?.errors?.opponentAnalysis || '')
    }
    return (status.modelActivity?.errors?.decision || []).find(Boolean) || ''
  }

  function runtimeFields(profile: EngineProfile): string {
    return JSON.stringify({
      engineId: profile.engineId,
      engineVersion: profile.engineVersion,
      enginePath: profile.enginePath,
      engineCommand: profile.engineCommand || [],
      engineCwd: profile.engineCwd || '',
      weights: profile.weights || [],
      device: profile.device || '',
      options: profile.options || {},
    })
  }

  function captureProfile(kind: EngineRuntimeKind, engines: EngineSettings) {
    const outputIds = kind === 'decision' ? ['action-recommendation'] : opponentOutputIds
    for (const outputId of outputIds) {
      const profileId = engines.outputAssignments[outputId as keyof typeof engines.outputAssignments]
      const profile = engines.profiles.find((item) => item.id === profileId)
      if (profile) runtimeProfiles[profile.id] = structuredClone(profile)
    }
  }

  function markConfiguredStarting(kind: EngineRuntimeKind, engines: EngineSettings) {
    const runtime = runtimeState(kind)
    if (runtime.ready || runtime.unloaded || runtimeError(kind)) return
    const profileId = kind === 'decision'
      ? engines.outputAssignments['action-recommendation']
      : opponentOutputIds.map((outputId) => engines.outputAssignments[outputId as keyof typeof engines.outputAssignments]).find(Boolean) || ''
    const profile = engines.profiles.find((item) => item.id === profileId)
    if (!profile?.enginePath || !(profile.weights || []).every((weight) => weight.path)) return
    if (runtime.profileId && runtime.profileId !== profileId) return

    Object.assign(runtime, { profileId, ready: false, unloaded: false })
    if (kind === 'decision') status.modelActivity.decision = ['loading', 'idle', 'idle', 'idle']
    else status.modelActivity.opponentAnalysis = 'loading'
  }

  function profileRuntimeState(
    profile: EngineProfile,
    kind: EngineRuntimeKind,
  ): { ready: boolean; unloaded: boolean } | null {
    const captured = runtimeProfiles[profile.id]
    if (!captured || runtimeFields(profile) !== runtimeFields(captured)) return null
    const runtime = runtimeState(kind)
    const specific = runtime.profiles?.[profile.id]
    if (specific) return specific
    if (runtime.profileId === profile.id || runtime.profileIds?.includes(profile.id) === true) return runtime
    return null
  }

  function profileRuntimeKinds(profile: EngineProfile): EngineRuntimeKind[] {
    const outputs = assignedOutputs(profile)
    const kinds: EngineRuntimeKind[] = []
    if (outputs.includes('action-recommendation')) kinds.push('decision')
    if (outputs.some((output) => output !== 'action-recommendation')) kinds.push('opponent')
    return kinds
  }

  function profileMatchesRuntime(profile: EngineProfile, kind: EngineRuntimeKind): boolean {
    return profileRuntimeState(profile, kind) !== null
  }

  return {
    captureRuntimeEngineProfile: captureProfile,
    markConfiguredEngineStarting: markConfiguredStarting,
    profileMatchesRuntime,
    profileRuntimeKinds,
    profileRuntimeState,
    runtimeEngineError: runtimeError,
  }
}
